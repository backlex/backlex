/**
 * Cookie consent — the evidence half.
 *
 * Its own module rather than more of `services/consent.ts`, because that one
 * opens by saying it "does not store a visitor's answer… a policy is edited, a
 * visitor's answer is evidence and must never change under it." Two lifetimes,
 * two modules.
 *
 * ## Append-only, mechanically
 *
 * There is no update export here and there never should be. A visitor who
 * changes their mind gets a NEW row; the latest `created_at` for
 * `(site_id, subject_id)` is the standing answer. Three things remove a row —
 * the retention prune, the erasure surface, and the visitor's own withdrawal —
 * and all three are removals. `consent-records.test.ts` scans this file, comments
 * stripped, for any update call — because "we agreed not to" is not a
 * constraint.
 *
 * ## Nothing the caller says about themselves is trusted
 *
 * The banner runs on somebody else's page with no credential, so the body is
 * attacker-controlled in full. Three things are therefore NOT read from it:
 * `decision` is derived from `grants`; `grants` is clamped to the categories
 * the resolved artifact actually offered; and the tenant comes from the site,
 * never from the request. What the caller does control — the subject id, the
 * reported policy hash — is recorded as a claim and labelled as one.
 */
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Env } from "../env";
import {
  OPTIONAL_CATEGORIES,
  type ConsentDbCtx,
  type OptionalCategory,
} from "./consent";

const recordsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.consentRecords : sqlite.schema.consentRecords;

const versionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.consentVersions : sqlite.schema.consentVersions;

/** How the decision was made. A regulator's first question about a `granted`
 *  is whether a human clicked anything, so this is stored rather than assumed.
 *  `signal` is GPC / DNT — a browser-level preference, not an interaction. */
export const CONSENT_RECORD_SOURCES = ["banner", "preferences", "api", "signal"] as const;
export type ConsentRecordSource = (typeof CONSENT_RECORD_SOURCES)[number];

/** Whether the artifact the visitor named still resolves. Three answers, not
 *  two — an operator handing a regulator a consent log has to know which rows
 *  point at something. */
export const HASH_GRADES = ["current", "archived", "unresolved"] as const;
export type HashGrade = (typeof HASH_GRADES)[number];

export const CONSENT_DECISIONS = ["granted", "denied", "partial"] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

/**
 * A visitor's durable id, as minted by the banner.
 *
 * Bounded and character-restricted because it is caller-supplied and lands in
 * an index: without this, one visitor can write rows under a million distinct
 * 64-character subjects. The shape is what `crypto.randomUUID()` and a
 * base64url token both satisfy.
 */
export const SUBJECT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export interface ConsentRecord {
  id: string;
  siteId: string;
  subjectId: string;
  policyHash: string | null;
  versionId: string | null;
  hashGrade: HashGrade;
  decision: ConsentDecision;
  grants: Record<string, boolean>;
  source: ConsentRecordSource;
  locale: string | null;
  country: string | null;
  userAgent: string | null;
  createdAt: number;
}

const tsValue = (v: unknown): number =>
  v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v ?? 0);

const tsParam = (dialect: "pg" | "sqlite", ms: number): Date | number =>
  dialect === "pg" ? new Date(ms) : ms;

const tenantEq = (col: any, tenantId: string | null) =>
  tenantId === null ? isNull(col) : eq(col, tenantId);

/**
 * A salted digest of the request address — never the address.
 *
 * Two independent reasons, and neither is optional. An IP is personal data, so
 * storing it would make a consent-proof table its own processing activity; and
 * it proves less than it looks like it does, because `requestMeta` reads
 * `cf-connecting-ip` first on EVERY runtime and nothing in the four entry
 * points sets or strips it — off Cloudflare the value is whatever the caller
 * typed.
 *
 * The salt is what makes the digest a pseudonym. An unsalted SHA-256 of an IPv4
 * address is reversible by brute force in seconds; there are only 2^32 of them.
 * Same construction as `erasure.ts::subjectHashFor`, for the same reason.
 */
export const consentIpHash = async (
  env: Env,
  tenantId: string | null,
  ip: string | null,
): Promise<string | null> => {
  if (!ip || ip === "unknown") return null;
  const material = `${env.AUTH_SECRET}\0${tenantId ?? ""}\0consent-ip\0${ip}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Reduce a caller's claimed grants to the categories the policy actually
 * offered.
 *
 * The banner is on a page we do not control, so `grants` arrives
 * attacker-shaped: unknown keys, missing keys, non-boolean values, a megabyte
 * of padding. Clamping to the offered list means a stored record can only ever
 * describe a question the operator actually asked — which is also what stops a
 * record claiming consent for a category the banner never displayed.
 *
 * A category the artifact offered but the body omitted is `false`. Absence is
 * not consent.
 */
export const clampGrants = (
  raw: unknown,
  offered: readonly OptionalCategory[],
): Record<string, boolean> => {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  const out: Record<string, boolean> = {};
  for (const cat of offered) out[cat] = src[cat] === true;
  return out;
};

/**
 * `granted` only if every offered category is granted; `denied` only if none
 * is. Derived here rather than read from the body, so the verdict and the
 * grants can never disagree — the same rule that makes the wording
 * server-owned, applied to the answer.
 *
 * A policy offering NOTHING (strictly-necessary only) yields `granted`: there
 * was nothing to withhold, and calling that "denied" would misreport a site
 * that asked for nothing as one that was refused.
 */
export const deriveDecision = (grants: Record<string, boolean>): ConsentDecision => {
  const values = Object.values(grants);
  if (!values.length || values.every((v) => v)) return "granted";
  if (values.every((v) => !v)) return "denied";
  return "partial";
};

/**
 * Resolve the artifact hash a visitor reports being shown.
 *
 * **An unknown hash never refuses the record.** Refusing does not un-consent
 * anyone — the site goes on behaving as consented — it only destroys the
 * evidence that the decision happened. It would also refuse almost everything
 * today: there is no backfill, so every policy that has not been re-saved since
 * the archive landed has zero rows in it.
 *
 * So the outcome is recorded instead of enforced: `current` when the hash is
 * the live artifact, `archived` when it is a real one since superseded, and
 * `unresolved` when it matches nothing. Only the ingest can tell these apart,
 * and only at the moment of the write.
 */
export const resolveHash = async (
  ctx: ConsentDbCtx,
  siteId: string,
  policyHash: string | null,
  currentHash: string | null,
): Promise<{ versionId: string | null; hashGrade: HashGrade }> => {
  if (!policyHash || !SHA256_HEX_RE.test(policyHash)) {
    return { versionId: null, hashGrade: "unresolved" };
  }
  const v = versionsTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select({ id: v.id })
    .from(v)
    .where(and(eq(v.siteId, siteId), eq(v.hash, policyHash)))
    .limit(1)) as any[];
  if (!row) return { versionId: null, hashGrade: "unresolved" };
  return {
    versionId: row.id,
    hashGrade: policyHash === currentHash ? "current" : "archived",
  };
};

export interface RecordConsentInput {
  siteId: string;
  tenantId: string | null;
  subjectId: string;
  /** The hash the CALLER reports. Recorded as a claim and graded, not trusted. */
  policyHash: string | null;
  /** The hash the site is serving right now, for grading. */
  currentHash: string | null;
  /** Categories the resolved artifact offered — the clamp's allow-list. */
  offered: readonly OptionalCategory[];
  grants: unknown;
  source: ConsentRecordSource;
  locale: string | null;
  country: string | null;
  ipHash: string | null;
  userAgent: string | null;
}

/** Append one decision. There is no update twin, deliberately — see the header. */
export const recordConsent = async (
  ctx: ConsentDbCtx,
  input: RecordConsentInput,
  now = Date.now(),
): Promise<{ id: string; decision: ConsentDecision; hashGrade: HashGrade }> => {
  const grants = clampGrants(input.grants, input.offered);
  const decision = deriveDecision(grants);
  const { versionId, hashGrade } = await resolveHash(
    ctx,
    input.siteId,
    input.policyHash,
    input.currentHash,
  );
  const id = crypto.randomUUID();
  await (ctx.db as any).insert(recordsTable(ctx.dialect)).values({
    id,
    tenantId: input.tenantId,
    siteId: input.siteId,
    subjectId: input.subjectId,
    policyHash: input.policyHash,
    versionId,
    hashGrade,
    decision,
    grants,
    source: input.source,
    locale: input.locale,
    country: input.country,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
    createdAt: tsParam(ctx.dialect, now),
  });
  return { id, decision, hashGrade };
};

const toRecord = (r: any): ConsentRecord => ({
  id: r.id,
  siteId: r.siteId,
  subjectId: r.subjectId,
  policyHash: r.policyHash ?? null,
  versionId: r.versionId ?? null,
  hashGrade: r.hashGrade,
  decision: r.decision,
  grants:
    r.grants && typeof r.grants === "object"
      ? (r.grants as Record<string, boolean>)
      : safeJson(r.grants),
  source: r.source,
  locale: r.locale ?? null,
  country: r.country ?? null,
  userAgent: r.userAgent ?? null,
  createdAt: tsValue(r.createdAt),
});

/** SQLite hands a json column back as raw TEXT; Postgres parses it. A blob that
 *  is malformed at rest must not take down a whole admin listing. */
const safeJson = (v: unknown): Record<string, boolean> => {
  if (typeof v !== "string") return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * The admin log for one site, newest first.
 *
 * `ipHash` is deliberately NOT projected. It exists so two records can be
 * correlated during an investigation, not so an operator browsing a list can
 * read a per-visitor identifier off the screen; a value that appears in a UI
 * ends up in a screenshot, a spreadsheet and a support ticket.
 */
export const listConsentRecords = async (
  ctx: ConsentDbCtx,
  tenantId: string | null,
  opts: { siteId?: string; subjectId?: string; limit?: number } = {},
): Promise<ConsentRecord[]> => {
  const t = recordsTable(ctx.dialect);
  const where = [tenantEq(t.tenantId, tenantId)];
  if (opts.siteId) where.push(eq(t.siteId, opts.siteId));
  if (opts.subjectId) where.push(eq(t.subjectId, opts.subjectId));
  const rows = (await (ctx.db as any)
    .select({
      id: t.id,
      siteId: t.siteId,
      subjectId: t.subjectId,
      policyHash: t.policyHash,
      versionId: t.versionId,
      hashGrade: t.hashGrade,
      decision: t.decision,
      grants: sql`${t.grants}`,
      source: t.source,
      locale: t.locale,
      country: t.country,
      userAgent: t.userAgent,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(and(...where))
    .orderBy(desc(t.createdAt))
    .limit(Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50) || 50)))) as any[];
  return rows.map(toRecord);
};

/**
 * Remove every decision a subject has recorded, optionally on one site.
 *
 * This is the visitor's own withdrawal AND the erasure surface's hook. Returns
 * a COUNT and never the rows: `docs/erasure.md`'s rule is that an erasure
 * report says how much was removed, never what it was.
 */
export const deleteSubjectRecords = async (
  ctx: ConsentDbCtx,
  tenantId: string | null,
  subjectId: string,
  siteId?: string,
): Promise<number> => {
  if (!subjectId) return 0;
  const t = recordsTable(ctx.dialect);
  const where = [tenantEq(t.tenantId, tenantId), eq(t.subjectId, subjectId)];
  if (siteId) where.push(eq(t.siteId, siteId));
  const ids = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(...where))) as { id: string }[];
  if (!ids.length) return 0;
  await (ctx.db as any)
    .delete(t)
    .where(
      inArray(
        t.id,
        ids.map((r) => r.id),
      ),
    );
  return ids.length;
};

/** How many decisions a subject holds, without reading any of them. Erasure's
 *  dry-run counts before it deletes. */
export const countSubjectRecords = async (
  ctx: ConsentDbCtx,
  tenantId: string | null,
  subjectId: string,
): Promise<number> => {
  if (!subjectId) return 0;
  const t = recordsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(tenantEq(t.tenantId, tenantId), eq(t.subjectId, subjectId)))) as unknown[];
  return rows.length;
};

/** Every site's records for one site id, removed. Used when a site is deleted:
 *  the subject of the evidence is what is going away. */
export const deleteSiteRecords = async (
  ctx: ConsentDbCtx,
  siteId: string,
): Promise<void> => {
  if (!siteId) return;
  const t = recordsTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.siteId, siteId));
};

/**
 * Drop decisions older than the retention window.
 *
 * Tenant-blind on purpose — it rides the scheduler's single sweep and there is
 * one clock for the whole instance, the same shape every other prune here has.
 */
export const pruneConsentRecords = async (
  ctx: ConsentDbCtx,
  olderThanMs: number,
): Promise<number> => {
  const t = recordsTable(ctx.dialect);
  const cutoff = tsParam(ctx.dialect, olderThanMs);
  const ids = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(lt(t.createdAt, cutoff))
    .limit(5_000)) as { id: string }[];
  if (!ids.length) return 0;
  await (ctx.db as any).delete(t).where(
    inArray(
      t.id,
      ids.map((r) => r.id),
    ),
  );
  return ids.length;
};

/** Re-exported so a caller clamping grants does not have to reach into the
 *  policy module for the canonical list. */
export { OPTIONAL_CATEGORIES };
