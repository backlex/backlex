/**
 * Half-filled forms, kept so the person can come back to them.
 *
 * A long survey loses people at the point where they have to finish it in one
 * sitting. Opt-in per form (`settings.saveProgress`), the public page posts the
 * answers it has as they are given, and the definition read hands them back on
 * the next visit — same questions, same step, already filled in.
 *
 * WHAT IDENTIFIES A VISITOR is deliberately not new machinery: it is whatever
 * they already hold. An invited person holds their invite token, so their draft
 * follows the link — the mail they were sent resumes the form on their phone
 * as well as their laptop. Everyone else gets an opaque, HttpOnly cookie, which
 * is the same courtesy-not-a-count posture as `onePerBrowser`: another browser
 * starts fresh, and the admin toggle says so.
 *
 * Only the SHA-256 of that secret is stored (`key_hash`), exactly as for form
 * and invite tokens. The table is therefore a pile of partial answers that
 * nobody — including a read of the table itself — can attribute to a link
 * without holding the link.
 *
 * Every read degrades to null/no-op when the table hasn't been migrated yet,
 * the same posture the rest of the forms feature takes: a workspace mid-upgrade
 * shows a form that doesn't remember, rather than a 500.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../context";
import { hashToken } from "./shared-links";

const draftsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.formDrafts : sqlite.schema.formDrafts;

/** Cookie that carries the resume secret for a form entered through its open
 *  link. Named after a hash of the form id, not the id: a cookie is the one
 *  place a page hands its own storage to whoever is looking. */
export const FORM_DRAFT_COOKIE_PREFIX = "blx_fp_";

/** Bytes of randomness in a cookie-held resume secret. It is a bearer key to
 *  one person's partial answers, so it is sized like every other token here. */
const SECRET_BYTES = 24;

/**
 * Most JSON one draft may hold.
 *
 * Generous for a survey (a hundred long-text answers fit) and small enough that
 * a public endpoint writing rows on a timer can't be turned into free storage.
 */
export const FORM_DRAFT_MAX_BYTES = 64 * 1024;

/** How long an untouched draft survives. A form left for a month is abandoned;
 *  keeping the answers past that is holding personal data for nothing. */
export const FORM_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows one sweep pass deletes — bounded so the cron tick stays a tick. */
const SWEEP_LIMIT = 500;

export interface FormDraft {
  /** Answers so far, in the same shape the page holds them. */
  data: Record<string, unknown>;
  /** Step page the visitor had reached. */
  step: number;
  /** When it was last written, epoch ms. */
  savedAt: number;
}

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Mint a resume secret for a visitor who arrived without one. */
export const newFormDraftSecret = (): string => randomHex(SECRET_BYTES);

/**
 * The lookup key for a resume secret.
 *
 * Domain-separated from every other hashed token in the system: a draft key is
 * derived from an invite token on invite-only forms, and without the prefix the
 * two would hash to the same value — a draft row that could be found by a
 * lookup meant for invites, and vice versa.
 */
export const formDraftKeyHash = (secret: string): Promise<string> =>
  hashToken(`backlex:form-draft:v1:${secret}`);

/** Name of the cookie that carries this form's resume secret. */
export const formDraftCookieName = async (formId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(formId),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 6), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${FORM_DRAFT_COOKIE_PREFIX}${hex}`;
};

const asMs = (v: Date | number | null | undefined): number =>
  v instanceof Date ? v.getTime() : Number(v ?? 0);

/** The draft this key holds, or null when there is none (or the table is not
 *  there yet). Expired ones read as absent — the sweep deletes them, but a
 *  visitor must not get a month-old form back because the tick hasn't run. */
export const loadFormDraft = async (
  ctx: Ctx,
  formId: string,
  keyHash: string,
): Promise<FormDraft | null> => {
  const t = draftsTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.formId, formId), eq(t.keyHash, keyHash)))
      .limit(1)) as any[];
    const row = rows[0];
    if (!row) return null;
    const savedAt = asMs(row.updatedAt);
    if (savedAt && Date.now() - savedAt > FORM_DRAFT_TTL_MS) return null;
    const data =
      row.data && typeof row.data === "object" && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {};
    return { data, step: Number(row.step ?? 0), savedAt };
  } catch {
    return null;
  }
};

/**
 * Write the answers so far.
 *
 * An upsert on `(form_id, key_hash)` rather than a read-then-write: the page
 * saves on a timer, and two tabs of the same person — or one tab whose debounce
 * fired twice — would otherwise check-then-insert into two rows and resume from
 * whichever the next read happened to find.
 */
export const saveFormDraft = async (
  ctx: Ctx,
  input: {
    formId: string;
    tenantId: string | null;
    keyHash: string;
    data: Record<string, unknown>;
    step: number;
  },
): Promise<number> => {
  const t = draftsTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any)
    .insert(t)
    .values({
      id: crypto.randomUUID(),
      formId: input.formId,
      tenantId: input.tenantId,
      keyHash: input.keyHash,
      data: input.data,
      step: input.step,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [t.formId, t.keyHash],
      set: { data: input.data, step: input.step, updatedAt: now },
    });
  return asMs(now);
};

/** Forget one visitor's draft — the submit that completed it, or a "start
 *  over". Best-effort: a draft that outlives its submission is stale data, not
 *  a failed submission, and must never turn a 201 into a 500. */
export const deleteFormDraft = async (
  ctx: Ctx,
  formId: string,
  keyHash: string,
): Promise<void> => {
  const t = draftsTable(ctx.dialect);
  try {
    await (ctx.db as any)
      .delete(t)
      .where(and(eq(t.formId, formId), eq(t.keyHash, keyHash)));
  } catch {
    // Best-effort.
  }
};

/** Drop every draft of one form. Called when the form is deleted: the answers
 *  are personal data whose only reason to exist was a form that no longer does. */
export const deleteFormDrafts = async (ctx: Ctx, formId: string): Promise<void> => {
  const t = draftsTable(ctx.dialect);
  try {
    await (ctx.db as any).delete(t).where(eq(t.formId, formId));
  } catch {
    // Best-effort — the form row is already gone, which is the part that matters.
  }
};

/** How many drafts a form is holding — the "started but not finished" figure
 *  the results panel shows beside its answers. */
export const countFormDrafts = async (ctx: Ctx, formId: string): Promise<number> => {
  const t = draftsTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(eq(t.formId, formId))) as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
};

/** Delete drafts nobody came back to. Runs from `cronTick` beside the stale
 *  form-upload sweep, for the same reason: an anonymous write path must not
 *  accumulate. */
export const sweepStaleFormDrafts = async (ctx: Ctx): Promise<void> => {
  const t = draftsTable(ctx.dialect);
  const cutoff = Date.now() - FORM_DRAFT_TTL_MS;
  // Cast for the same reason `routes/items.ts` does: the dual-dialect union
  // gives the column two incompatible types and neither overload accepts both.
  const rows = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(lt(t.updatedAt as any, ctx.dialect === "pg" ? new Date(cutoff) : cutoff))
    .limit(SWEEP_LIMIT)) as Array<{ id: string }>;
  for (const row of rows) {
    try {
      await (ctx.db as any).delete(t).where(eq(t.id, row.id));
    } catch (e) {
      console.error(`[form-drafts] sweep failed for ${row.id}`, e);
    }
  }
};
