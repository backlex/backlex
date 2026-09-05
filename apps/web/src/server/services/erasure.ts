/**
 * Data-subject erasure (GDPR Art. 17 and the equivalents elsewhere).
 *
 * A deletion request is not a `DELETE`. One person's data is spread across the
 * end-user record, the collections that reference them, the revision history of
 * those rows, the activity log, comments, notifications, analytics, crash
 * reports, their devices and their uploaded files. An operator cannot see all
 * of that from one screen — which is exactly why backlex should do it and an
 * app on top of backlex cannot: the relation graph and the physical tables are
 * here.
 *
 * Three decisions shape the module:
 *
 * **Two steps, always.** A request is previewed into a plan of counts, and only
 * then executed. Erasure is irreversible; "run it and see" is not an interface.
 *
 * **Revisions go, whatever the mode.** Anonymizing a row while keeping its
 * revision history is theatre: the old email is sitting in the snapshot. So a
 * touched item's revisions are deleted even in `anonymize` mode.
 *
 * **The record of the erasure must not re-create it.** Nothing here stores the
 * subject's address or id — only a salted hash and per-surface counts. An audit
 * row reading "we erased alice@example.com" would outlive every row it removed.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import { isLocalized, sidecarFields } from "@backlex/db";
import { deleteEverywhere } from "./storage/bucket-for";
import type { Ctx } from "../context";
import { loadCollection, type CollectionRow } from "./items/collection-loader";
import { execute, queryAll } from "./items/sql-helpers";
import { deserializeRow } from "./items/serialize";
import { sidecarClear, sidecarDeleteRow } from "./items/i18n-sidecar";
import { deleteFts, indexFts } from "./fts";
import { deleteVector, embedAndUpsert } from "./vectorize";
import { removeAppUserFromAllOrgs } from "./app-orgs";

type AnyDb = any;

const t = (ctx: Ctx) => (ctx.dialect === "pg" ? pg.schema : sqlite.schema) as typeof pg.schema;

/**
 * Surfaces this module reaches, in the order it walks them.
 *
 * Exported because the report is keyed by these and the UI, the docs and the
 * tests all need the same list — a second copy would drift and the drift would
 * look like "that surface had nothing in it".
 */
export const ERASURE_SURFACES = [
  "collections",
  "revisions",
  "files",
  "comments",
  "notifications",
  "activity",
  "analytics",
  "errors",
  "devices",
  "identity",
  /** Recorded cookie-consent decisions. Reachable ONLY by `consent_id` — a
   *  consent record carries no email and no account, so an `email` or
   *  `app_user` request will not find one. `docs/erasure.md` says so plainly
   *  rather than letting the count read as "they had none". */
  "consent",
  /** Stored objects the adapter could not remove. Non-zero means the row is
   *  gone but the bytes are not — an operator has to know that. */
  "filesUnreachable",
] as const;

export type ErasureSurface = (typeof ERASURE_SURFACES)[number];

/**
 * What erasure CANNOT reach, stated in the report rather than left implicit.
 *
 * A tool that quietly ignores these while reporting "completed" is worse than
 * no tool: it tells an operator a legal obligation is discharged when it is not.
 */
export const ERASURE_LIMITS = [
  "Backups taken before this request still contain the subject; that is a retention-policy matter, not something erasure can reach.",
  "Data already delivered to third parties through integrations, webhooks or a warehouse sync must be erased at those destinations separately.",
] as const;

export type ErasureMode = "anonymize" | "delete";
export const ERASURE_MODES: readonly ErasureMode[] = ["anonymize", "delete"];

/**
 * `consent_id` is the opaque token a cookie banner minted in the visitor's own
 * browser. It is the only handle an anonymous visitor has, and it is one the
 * OPERATOR cannot discover — a request naming one is acting on a value the
 * subject supplied.
 */
export type SubjectType = "app_user" | "email" | "consent_id";

export interface ErasureSubject {
  type: SubjectType;
  /** An app-user id, or an email address. Normalized before hashing. */
  value: string;
}

/** Per-surface counts. The plan and the report share this shape so a reader can
 *  diff "what we said we would do" against "what we did". */
export type ErasureCounts = Partial<Record<ErasureSurface, number>>;

export interface ErasureRequestRow {
  id: string;
  tenantId: string;
  subjectType: string;
  subjectHash: string;
  mode: string;
  status: string;
  plan: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  error: string | null;
  reference: string | null;
  requestedBy: string | null;
  previewedAt: Date | number | null;
  completedAt: Date | number | null;
  createdAt: Date | number | null;
}

/** Public view. There is nothing to redact — the row never held the subject. */
export const toPublicErasure = (row: ErasureRequestRow) => ({
  id: row.id,
  subjectType: row.subjectType,
  /** First 12 hex chars: enough to recognise a repeat request, useless alone. */
  subjectRef: row.subjectHash.slice(0, 12),
  mode: row.mode,
  status: row.status,
  plan: row.plan,
  report: row.report,
  error: row.error,
  reference: row.reference,
  requestedBy: row.requestedBy,
  previewedAt: row.previewedAt,
  completedAt: row.completedAt,
  createdAt: row.createdAt,
  limits: [...ERASURE_LIMITS],
});

export type PublicErasureRequest = ReturnType<typeof toPublicErasure>;

const normalizeSubject = (subject: ErasureSubject): string =>
  subject.type === "email" ? subject.value.trim().toLowerCase() : subject.value.trim();

/**
 * Salted with AUTH_SECRET on purpose.
 *
 * An unsalted hash of an email address is not a pseudonym — the space of real
 * addresses is small enough to enumerate, so anyone with the table could
 * recover who was erased. The salt is what makes the digest useless outside
 * this instance.
 */
export const subjectHashFor = async (
  authSecret: string,
  tenantId: string,
  subject: ErasureSubject,
): Promise<string> => {
  const material = `${authSecret}\0${tenantId}\0${subject.type}\0${normalizeSubject(subject)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Does this field hold an email address?
 *
 * Two ways, and the first one used to be missing.
 *
 * **The `email` field type.** It normalizes and validates the address on write
 * (see `docs/email.md`) — declaring it IS the declared intent, so it needs no
 * heuristic. This clause was absent, and the docblock here asserted "there is
 * no `email` field type", which was true when it was written and stopped being
 * true when the type shipped. The effect was backwards from what anyone would
 * want: a `text` field named `email` was erased and the same address in a
 * properly-declared `email` field was not, so **modelling the schema correctly
 * made a GDPR erasure quietly miss rows** — and it failed as a clean preview
 * reporting zero, which reads exactly like "nothing to erase".
 *
 * **A text field with declared intent.** `interface`, a validation `format`, or
 * — the heuristic — a text field literally named `email`, which is how most
 * hand-built collections spell it. The match still requires the VALUE to equal
 * the subject's address, so a false positive means a row that genuinely
 * contains their email, and the preview exists so the operator sees it before
 * anything is destroyed.
 */
const isEmailField = (f: { name: string; type: string; interface?: string; validation?: { format?: string } }): boolean =>
  f.type === "email" ||
  ((f.type === "text" || f.type === "longtext") &&
    (f.interface === "email" || f.validation?.format === "email" || f.name.toLowerCase() === "email"));

// ── Locating the subject ─────────────────────────────────────────────────────

/** Where the subject was found. Ids only — never the values that identified them. */
export interface SubjectLocation {
  /** The `app_users` row, when one matched. */
  appUserId: string | null;
  /** Rows in user collections: slug → primary keys. */
  items: { slug: string; ids: string[] }[];
  /** Consent-record subject ids this request names. Empty for every subject
   *  type but `consent_id`, because nothing links a consent record to an
   *  account or an address.
   *
   *  This replaces a `distinctIds` field that was declared, assigned
   *  `[appUserId]`, and never read anywhere in the repo. */
  consentIds: string[];
}

/**
 * Resolve a subject to the rows that are theirs.
 *
 * Two mechanisms, and the split is deliberate. Ownership is authoritative:
 * an owner-scoped collection says outright whose row it is. Matching on an
 * `email` field is a heuristic — it finds the common case (a `customers` table
 * keyed by address) without the operator configuring anything, and the preview
 * exists so they can see what it found before anything is destroyed.
 */
export async function locateSubject(
  ctx: Ctx,
  tenantId: string,
  subject: ErasureSubject,
): Promise<SubjectLocation> {
  const s = t(ctx);
  const db = ctx.db as AnyDb;
  const value = normalizeSubject(subject);

  let appUserId: string | null = null;
  let email: string | null = subject.type === "email" ? value : null;

  // A cookie-consent subject resolves to nothing else, and the early return is
  // the point rather than an optimisation. The value is an opaque token from a
  // visitor's browser: it is not an account id and not an address, so looking
  // it up in `app_users` or matching it against collections' email fields can
  // only ever waste work or produce a false positive on a row that happens to
  // contain the same string.
  //
  // The `else if` below is load-bearing for the same reason. Left as a bare
  // `else`, a consent id would fall into the EMAIL lookup, find no user, scan
  // every collection for it, and report all-zero — a false "nothing to erase",
  // which is the exact failure this module exists to prevent.
  if (subject.type === "consent_id") {
    return { appUserId: null, items: [], consentIds: [value] };
  }

  if (subject.type === "app_user") {
    const [row] = (await db
      .select()
      .from(s.appUsers)
      .where(and(eq(s.appUsers.tenantId, tenantId), eq(s.appUsers.id, value)))) as {
      id: string;
      email: string | null;
    }[];
    if (!row) throw new AppError("NOT_FOUND", "No end user with that id in this workspace");
    appUserId = row.id;
    email = row.email ? row.email.toLowerCase() : null;
  } else if (subject.type === "email") {
    const rows = (await db
      .select()
      .from(s.appUsers)
      .where(and(eq(s.appUsers.tenantId, tenantId), eq(s.appUsers.email, value)))) as { id: string }[];
    // An address with no account is still a subject — it may appear in a
    // collection. Not finding a user is not "nothing to erase".
    appUserId = rows[0]?.id ?? null;
  }

  const slugs = (await db
    .select({ slug: s.collections.slug })
    .from(s.collections)
    .where(eq(s.collections.tenantId, tenantId))) as { slug: string }[];
  const items: { slug: string; ids: string[] }[] = [];

  for (const { slug } of slugs) {
    const c = await loadCollection(ctx, tenantId, slug);
    // An adopted table is somebody else's application. Deleting from it is not
    // ours to do, and the operator never told us what its columns mean.
    if (c.adopted) continue;

    const matches = [];
    if (c.ownerScoped && appUserId) {
      matches.push(sql`${sql.identifier(c.ownerIdColumn ?? "owner_id")} = ${appUserId}`);
    }
    if (email) {
      for (const f of c.fields) {
        if (!isEmailField(f)) continue;
        matches.push(sql`lower(${sql.identifier(f.name)}) = ${email}`);
      }
    }
    if (matches.length === 0) continue;

    // Table and column names come from collection metadata and go through
    // `sql.identifier`; the subject's own value is always a bound parameter.
    let where = matches[0]!;
    for (const m of matches.slice(1)) where = sql`${where} OR ${m}`;
    if (c.tenantScoped) where = sql`${sql.identifier("tenant_id")} = ${tenantId} AND (${where})`;

    let rows: { id: unknown }[];
    try {
      rows = await queryAll<{ id: unknown }>(
        ctx,
        sql`SELECT ${sql.identifier(c.pkColumn)} AS id FROM ${sql.identifier(c.physicalTable)} WHERE ${where}`,
      );
    } catch (e) {
      // A collection whose physical table is mid-migration must not abort the
      // whole scan — but it also must not be silently reported as empty.
      throw new AppError(
        "INTERNAL",
        `Could not scan collection "${slug}" for this subject: ${(e as Error).message}`,
      );
    }
    if (rows.length > 0) items.push({ slug, ids: rows.map((r) => String(r.id)) });
  }

  return { appUserId, items, consentIds: [] };
}

// ── Counting, then doing ─────────────────────────────────────────────────────

const requests = (ctx: Ctx) =>
  (ctx.dialect === "pg"
    ? pg.schema.erasureRequests
    : sqlite.schema.erasureRequests) as typeof pg.schema.erasureRequests;

/** Ids of every item the subject touches, flattened for the revision sweep. */
const allItemIds = (loc: SubjectLocation): string[] => loc.items.flatMap((i) => i.ids);

/**
 * Count what each surface holds for this subject.
 *
 * Deliberately a separate walk from the deletion rather than a shared "collect
 * then act": the preview must not be able to mutate anything, and a shared
 * code path is one refactor away from doing so.
 */
async function countSurfaces(
  ctx: Ctx,
  tenantId: string,
  loc: SubjectLocation,
): Promise<ErasureCounts> {
  const s = t(ctx);
  const db = ctx.db as AnyDb;
  const itemIds = allItemIds(loc);
  const counts: ErasureCounts = {};

  counts.collections = itemIds.length;

  const count = async (table: unknown, where: unknown): Promise<number> => {
    const rows = (await db.select({ n: sql<number>`count(*)` }).from(table as never).where(where as never)) as {
      n: number | string;
    }[];
    return Number(rows[0]?.n ?? 0);
  };

  counts.revisions =
    itemIds.length === 0
      ? 0
      : await count(
          s.revisions,
          and(eq(s.revisions.tenantId, tenantId), inArray(s.revisions.itemId, itemIds)),
        );

  // ABOVE the account branch below, deliberately. That branch has an `else`
  // that zeroes every remaining surface, so a consent count placed inside or
  // after it would report zero for the one subject type that can actually have
  // consent records — which is every consent subject, since none of them has an
  // account.
  counts.consent =
    loc.consentIds.length === 0
      ? 0
      : await count(
          s.consentRecords,
          and(
            eq(s.consentRecords.tenantId, tenantId),
            inArray(s.consentRecords.subjectId, loc.consentIds),
          ),
        );

  if (loc.appUserId) {
    const uid = loc.appUserId;
    counts.files = await count(s.files, and(eq(s.files.tenantId, tenantId), eq(s.files.ownerId, uid)));
    counts.comments = await count(
      s.comments,
      and(eq(s.comments.tenantId, tenantId), eq(s.comments.userId, uid)),
    );
    counts.notifications = await count(
      s.notifications,
      and(eq(s.notifications.tenantId, tenantId), eq(s.notifications.userId, uid)),
    );
    counts.activity = await count(
      s.activity,
      and(eq(s.activity.tenantId, tenantId), eq(s.activity.userId, uid)),
    );
    counts.analytics = await count(
      s.analyticsEvents,
      and(eq(s.analyticsEvents.tenantId, tenantId), eq(s.analyticsEvents.userId, uid)),
    );
    counts.errors = await count(
      s.errorEvents,
      and(eq(s.errorEvents.tenantId, tenantId), eq(s.errorEvents.userId, uid)),
    );
    counts.devices = await count(
      s.deviceTokens,
      and(eq(s.deviceTokens.tenantId, tenantId), eq(s.deviceTokens.userId, uid)),
    );
    counts.identity = 1;
  } else {
    for (const k of ["files", "comments", "notifications", "activity", "analytics", "errors", "devices"] as const) {
      counts[k] = 0;
    }
    // An address with no account still has zero identity rows — but the
    // collections above may well have hits, which is the point of allowing it.
    counts.identity = 0;
  }

  return counts;
}

export interface PreviewInput {
  subject: ErasureSubject;
  mode: ErasureMode;
  reference?: string | null;
}

/**
 * File a request and compute what it would touch. Nothing is destroyed here.
 */
export async function previewErasure(
  ctx: Ctx,
  tenantId: string,
  userId: string | null,
  input: PreviewInput,
): Promise<PublicErasureRequest> {
  if (!ERASURE_MODES.includes(input.mode)) {
    throw new AppError("VALIDATION", `mode must be one of: ${ERASURE_MODES.join(", ")}`);
  }
  if (!input.subject?.value?.trim()) throw new AppError("VALIDATION", "A subject is required");

  const loc = await locateSubject(ctx, tenantId, input.subject);
  const plan = await countSurfaces(ctx, tenantId, loc);
  const now = new Date();
  const id = crypto.randomUUID();

  await (ctx.db as AnyDb).insert(requests(ctx)).values({
    id,
    tenantId,
    subjectType: input.subject.type,
    subjectHash: await subjectHashFor(ctx.env.AUTH_SECRET, tenantId, input.subject),
    mode: input.mode,
    status: "previewed",
    plan: { counts: plan, collections: loc.items.map((i) => ({ slug: i.slug, rows: i.ids.length })) },
    reference: input.reference?.trim() || null,
    requestedBy: userId,
    previewedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const row = await getErasureRequest(ctx, tenantId, id);
  if (!row) throw new Error("erasure request missing after insert");
  return row;
}

export async function listErasureRequests(ctx: Ctx, tenantId: string): Promise<PublicErasureRequest[]> {
  const r = requests(ctx);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(r)
    .where(eq(r.tenantId, tenantId))) as ErasureRequestRow[];
  return rows
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
    .map(toPublicErasure);
}

const getRow = async (ctx: Ctx, tenantId: string, id: string): Promise<ErasureRequestRow | null> => {
  const r = requests(ctx);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(r)
    .where(and(eq(r.tenantId, tenantId), eq(r.id, id)))) as ErasureRequestRow[];
  return row ?? null;
};

export async function getErasureRequest(
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<PublicErasureRequest | null> {
  const row = await getRow(ctx, tenantId, id);
  return row ? toPublicErasure(row) : null;
}

/**
 * Carry it out.
 *
 * Re-locates the subject rather than trusting the plan: the preview may be
 * minutes or days old, and acting on a stale list would both miss rows written
 * since and try to delete rows already gone. The plan is a preview, not a
 * work order.
 */
export async function runErasure(
  ctx: Ctx,
  tenantId: string,
  id: string,
  subject: ErasureSubject,
): Promise<PublicErasureRequest> {
  const row = await getRow(ctx, tenantId, id);
  if (!row) throw new AppError("NOT_FOUND", "Erasure request not found");
  if (row.status === "completed") throw new AppError("CONFLICT", "This request has already been carried out");
  if (row.status !== "previewed" && row.status !== "failed") {
    throw new AppError("CONFLICT", "Preview the request before carrying it out");
  }
  // The caller has to name the same person again. The request row holds only a
  // hash, so this is also the only way to know WHO to erase — which is the
  // point: a stored subject would be a copy of the data we are removing.
  const hash = await subjectHashFor(ctx.env.AUTH_SECRET, tenantId, subject);
  if (hash !== row.subjectHash) {
    throw new AppError("VALIDATION", "The subject does not match the one this request was previewed for");
  }

  const r = requests(ctx);
  const db = ctx.db as AnyDb;
  await db.update(r).set({ status: "running", updatedAt: new Date() }).where(eq(r.id, id));

  try {
    const loc = await locateSubject(ctx, tenantId, subject);
    const report = await eraseEverywhere(ctx, tenantId, loc, row.mode as ErasureMode);
    await db
      .update(r)
      .set({
        status: "completed",
        report: { counts: report, limits: [...ERASURE_LIMITS] },
        error: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(r.id, id));
  } catch (e) {
    // Left `failed` with the reason rather than rolled back: erasure is not
    // transactional across these surfaces, so a partial run is a fact the
    // operator has to see and re-run, not something to hide.
    await db
      .update(r)
      .set({ status: "failed", error: (e as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(eq(r.id, id));
    throw e;
  }

  const out = await getErasureRequest(ctx, tenantId, id);
  if (!out) throw new Error("erasure request missing after run");
  return out;
}

/** A stable pseudonym for one subject, so anonymized rows stay joinable to each
 *  other without being joinable to a person. */
const pseudonymFor = (appUserId: string | null, id: string): string =>
  `erased-${(appUserId ?? id).slice(0, 8)}`;

/**
 * Re-index the rows an `anonymize` pass just rewrote.
 *
 * Both indexes are DERIVED from field values, so scrubbing the base column
 * without restating them leaves the original address searchable through
 * `?q=` and semantically retrievable through vector search — the row reads as
 * anonymized and answers to the person's name.
 *
 * One read per id rather than a batch: the write path's own re-index takes the
 * row it just wrote, and an erasure run is a rare operator action over a small
 * set. Failures inside `indexFts` / `embedAndUpsert` are already swallowed and
 * logged by those functions (a search index is never a reason to fail a write),
 * which is the right contract here too — the base row is already scrubbed.
 */
const reindexAfterScrub = async (
  ctx: Ctx,
  tenantId: string,
  c: CollectionRow,
  ids: readonly string[],
): Promise<void> => {
  for (const id of ids) {
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${sql.identifier(c.physicalTable)} WHERE ${sql.identifier(c.pkColumn)} = ${id} LIMIT 1`,
    );
    const raw = rows[0];
    if (!raw) continue;
    const row = deserializeRow(raw, c.fields, ctx.dialect, c.ownerScoped);
    await indexFts(ctx, c, id, row);
    await embedAndUpsert(ctx, c, tenantId, id, row);
  }
};

async function eraseEverywhere(
  ctx: Ctx,
  tenantId: string,
  loc: SubjectLocation,
  mode: ErasureMode,
): Promise<ErasureCounts> {
  const s = t(ctx);
  const db = ctx.db as AnyDb;
  const done: ErasureCounts = {};
  const itemIds = allItemIds(loc);

  // 1. Collection rows. Anonymize scrubs the identifying fields in place;
  //    delete removes the row. Either way the revisions go next.
  //
  //    **A row is not one place.** The same value that sits in the base column
  //    also sits in the full-text shadow table, in the embedding store, and —
  //    for a `localized` field — in the `__i18n` sidecar, because the write
  //    path put it in all four. This sweep wrote raw SQL against the base
  //    table alone and then reported `status: "completed"`: the row was gone
  //    from `c_…_customers` while `SELECT content FROM c_…_customers__fts`
  //    still returned `victim@example.com`, verbatim and searchable. So each
  //    id goes through the same index maintenance `performDelete` /
  //    `performUpdate` run, and the report stops overstating what it did.
  let touched = 0;
  for (const hit of loc.items) {
    const c = await loadCollection(ctx, tenantId, hit.slug);
    const idIn = sql.join(
      hit.ids.map((v) => sql`${v}`),
      sql`, `,
    );
    const where = sql`${sql.identifier(c.pkColumn)} IN (${idIn})`;
    if (mode === "delete") {
      await execute(ctx, sql`DELETE FROM ${sql.identifier(c.physicalTable)} WHERE ${where}`);
      // The sidecar has no FK cascade on SQLite/D1, so its rows outlive the
      // base row unless they are named. Guarded on the collection actually
      // having a sidecar table — otherwise the statement targets nothing.
      if (sidecarFields(c.fields).length > 0) {
        for (const id of hit.ids) {
          await execute(ctx, sidecarDeleteRow(c.physicalTable, id));
        }
      }
      for (const id of hit.ids) {
        await deleteFts(ctx, c, id);
        await deleteVector(ctx, c, tenantId, id);
      }
    } else {
      const scrubbed = c.fields.filter(
        (f) => isEmailField(f) || f.interface === "phone" || f.name.toLowerCase() === "name",
      );
      const sets = scrubbed.map((f) =>
        isEmailField(f)
          ? sql`${sql.identifier(f.name)} = ${`${pseudonymFor(loc.appUserId, hit.slug)}@erased.invalid`}`
          : sql`${sql.identifier(f.name)} = ${null}`,
      );
      if (c.ownerScoped) sets.push(sql`${sql.identifier(c.ownerIdColumn ?? "owner_id")} = ${null}`);
      if (sets.length > 0) {
        let assign = sets[0]!;
        for (const x of sets.slice(1)) assign = sql`${assign}, ${x}`;
        await execute(
          ctx,
          sql`UPDATE ${sql.identifier(c.physicalTable)} SET ${assign} WHERE ${where}`,
        );
      }
      // A `localized` field's value never lived in the base column this just
      // scrubbed — it lives one per locale in the sidecar, so an anonymize
      // that touched only the base table left every translation of the name
      // and the address exactly where they were.
      for (const f of scrubbed.filter((x) => isLocalized(x))) {
        for (const id of hit.ids) {
          await execute(ctx, sidecarClear(c.physicalTable, id, f.name));
        }
      }
      // Re-index from the SCRUBBED row. Both indexes are built from field
      // values, so leaving them alone would keep the pre-anonymization text
      // searchable and semantically retrievable under the pseudonymized row.
      await reindexAfterScrub(ctx, tenantId, c, hit.ids);
    }
    touched += hit.ids.length;
  }
  done.collections = touched;

  // 2. Revisions. Deleted in BOTH modes: a snapshot holds the pre-anonymization
  //    row, so keeping it would leave the address exactly where it was.
  done.revisions = 0;
  if (itemIds.length > 0) {
    const del = await db
      .delete(s.revisions)
      .where(and(eq(s.revisions.tenantId, tenantId), inArray(s.revisions.itemId, itemIds)))
      .returning({ id: s.revisions.id });
    done.revisions = Array.isArray(del) ? del.length : 0;
  }

  // 2b. Recorded consent. ABOVE the early return below, which is what makes it
  //     reachable at all: a consent subject never has an account, so every step
  //     under `if (!uid) return` is dead code for exactly this subject.
  //
  //     DELETED IN BOTH MODES, never anonymized. `subject_id` IS the
  //     identifier here — scrubbing it would leave a row carrying a user agent,
  //     an ip hash and a timestamp, which identifies nobody and proves nothing,
  //     so the row would be retained for no purpose. The same call `revisions`
  //     makes above, and the same one the activity log makes below.
  done.consent = 0;
  if (loc.consentIds.length > 0) {
    const del = await db
      .delete(s.consentRecords)
      .where(
        and(
          eq(s.consentRecords.tenantId, tenantId),
          inArray(s.consentRecords.subjectId, loc.consentIds),
        ),
      )
      .returning({ id: s.consentRecords.id });
    done.consent = Array.isArray(del) ? del.length : 0;
  }

  const uid = loc.appUserId;
  if (!uid) {
    for (const k of ["files", "comments", "notifications", "activity", "analytics", "errors", "devices", "identity"] as const) {
      done[k] = 0;
    }
    return done;
  }

  const removeAll = async (table: unknown, where: unknown, idCol: unknown): Promise<number> => {
    const del = await db
      .delete(table as never)
      .where(where as never)
      .returning({ id: idCol as never });
    return Array.isArray(del) ? del.length : 0;
  };

  // 3. Files. The stored OBJECT goes first — a profile photo is personal data,
  //    and deleting only the row would leave it in the bucket with nothing left
  //    pointing at it, which is worse than leaving both. Object deletes are
  //    best-effort per key: one unreachable object must not abort an erasure
  //    that has already destroyed rows, so failures are counted and surfaced
  //    instead of thrown.
  const fileRows = (await db
    .select({ key: s.files.key })
    .from(s.files)
    .where(and(eq(s.files.tenantId, tenantId), eq(s.files.ownerId, uid)))) as { key: string }[];
  let objectsLeft = 0;
  for (const f of fileRows) {
    // Every bucket, not the one this row's ACL names — the row is selected as
    // `{ key }` alone and has no ACL to route on. On a deployment that keeps
    // public objects in a second, world-readable bucket, deleting only from the
    // private one would report a complete erasure while leaving the person's
    // files fetchable forever, with the row that pointed at them destroyed. See
    // `services/storage/bucket-for.ts::deleteEverywhere`.
    if (!(await deleteEverywhere(ctx, f.key)).ok) objectsLeft++;
  }
  done.files = await removeAll(
    s.files,
    and(eq(s.files.tenantId, tenantId), eq(s.files.ownerId, uid)),
    s.files.key,
  );
  if (objectsLeft > 0) done.filesUnreachable = objectsLeft;

  done.comments = await removeAll(
    s.comments,
    and(eq(s.comments.tenantId, tenantId), eq(s.comments.userId, uid)),
    s.comments.id,
  );
  done.notifications = await removeAll(
    s.notifications,
    and(eq(s.notifications.tenantId, tenantId), eq(s.notifications.userId, uid)),
    s.notifications.id,
  );
  // The activity log carries IP and user-agent alongside request payloads, so
  // scrubbing the user id would leave the person identifiable anyway.
  done.activity = await removeAll(
    s.activity,
    and(eq(s.activity.tenantId, tenantId), eq(s.activity.userId, uid)),
    s.activity.id,
  );
  done.analytics = await removeAll(
    s.analyticsEvents,
    and(eq(s.analyticsEvents.tenantId, tenantId), eq(s.analyticsEvents.userId, uid)),
    s.analyticsEvents.id,
  );
  // Crash reports carry a stack and a free-form context blob; the same applies.
  done.errors = await removeAll(
    s.errorEvents,
    and(eq(s.errorEvents.tenantId, tenantId), eq(s.errorEvents.userId, uid)),
    s.errorEvents.id,
  );
  done.devices = await removeAll(
    s.deviceTokens,
    and(eq(s.deviceTokens.tenantId, tenantId), eq(s.deviceTokens.userId, uid)),
    s.deviceTokens.id,
  );

  // 4. The identity itself, last — everything above keys off it.
  await db.delete(s.appSessions).where(eq(s.appSessions.userId, uid));
  await db.delete(s.appAccounts).where(eq(s.appAccounts.userId, uid));
  await db.delete(s.appUserRoles).where(eq(s.appUserRoles.appUserId, uid));
  // Memberships, org-scoped role bindings and any session pin, in one place —
  // dropping only `app_org_members` leaves role bindings orphaned and the
  // per-isolate membership cache still serving the erased subject.
  await removeAppUserFromAllOrgs({ db, dialect: ctx.dialect }, tenantId, uid);
  await db.delete(s.externalIdentities).where(eq(s.externalIdentities.userId, uid));
  await db.delete(s.phoneNumbers).where(eq(s.phoneNumbers.userId, uid));

  if (mode === "delete") {
    await db
      .delete(s.appUsers)
      .where(and(eq(s.appUsers.tenantId, tenantId), eq(s.appUsers.id, uid)));
  } else {
    // Kept so foreign keys elsewhere still resolve, but with nothing left that
    // names a person. `isAnonymous` is what tells the rest of the platform this
    // is a tombstone rather than a real account.
    await db
      .update(s.appUsers)
      .set({
        email: `${pseudonymFor(uid, uid)}@erased.invalid`,
        name: "Erased user",
        image: null,
        emailVerified: false,
        isAnonymous: true,
        status: "suspended",
      })
      .where(and(eq(s.appUsers.tenantId, tenantId), eq(s.appUsers.id, uid)));
  }
  done.identity = 1;

  return done;
}
