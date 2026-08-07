/**
 * Public form builder — embeddable, unauthenticated forms whose submissions
 * are written into a collection through the items write core (`performCreate`),
 * so field validation, hashed fields, flows/webhooks/realtime and the audit
 * trail all apply unchanged.
 *
 * The plaintext token (`frm_<hex>`) is returned exactly once (create/rotate);
 * only its SHA-256 hash is persisted — same scheme as `services/shared-links.ts`.
 * Every read degrades gracefully (try/catch → null/[]) when the `forms` table
 * hasn't been migrated yet, the same posture as shared-links/dashboards.
 *
 * A form is a list of BLOCKS. `kind: "field"` blocks expose one collection
 * field (label/placeholder/help overrides, optional show-condition, per-locale
 * strings); `kind: "step"` blocks are presentation-only page breaks that turn
 * the public form into a multi-step flow. Legacy configs (plain
 * `{ name, label?, help? }` rows) parse as field blocks unchanged.
 *
 * Scope fence: scalar field types (text/longtext/integer/number/boolean/
 * timestamp — dropdowns are `text` + choices) plus single `file` fields can be
 * exposed. Relation/hash/json/localized/computed/private/auto-filled fields
 * are rejected at definition time AND re-filtered at read/submit time, so a
 * stale form definition can never leak or write a field that later became
 * ineligible. File blocks never accept a raw storage key — submits only take
 * the signed ticket minted by the public upload endpoint (`form-uploads.ts`),
 * so an anonymous submitter can't point a row at someone else's object.
 */
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { getChoices, type FieldDef } from "@backlex/db";
import type { Ctx } from "../context";
import type { CollectionRow } from "./items/collection-loader";
import { loadCollection } from "./items/collection-loader";
import { hashToken } from "./shared-links";

const formTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.forms : sqlite.schema.forms;

const TOKEN_PREFIX = "frm";
const TOKEN_BYTES = 24;

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Field types a form may expose. Dropdowns are `text` + `options.choices`;
 *  `file` blocks write the storage key minted by the public upload endpoint. */
const ALLOWED_TYPES = new Set<string>([
  "text",
  "longtext",
  "integer",
  "number",
  "boolean",
  "timestamp",
  "file",
]);

/** Per-locale overrides for one block. Empty/missing strings fall back to the
 *  base-language value. */
export interface FormBlockI18n {
  label?: string;
  placeholder?: string;
  help?: string;
}

/** Show-condition: the block renders only when another exposed field's current
 *  answer matches. Evaluated client-side for display AND ignored server-side
 *  for validation clamps (a hidden block's field is simply not required). */
export interface FormBlockCond {
  field: string;
  op: "is" | "is_not";
  value: string;
}

/**
 * A question answered by picking one point on a row — a star rating, a 1–10
 * satisfaction row, the 0–10 "how likely are you to recommend us" of NPS.
 *
 * It is a rendering + clamp instruction, not a storage one: the answer is an
 * ordinary integer in an ordinary integer column, which is what keeps the
 * results panel, dashboards and every export reading it as the number it is.
 * `rating: true` is the older spelling of `{ min: 1, max: 5, style: "stars" }`
 * and still parses.
 */
export interface FormBlockScale {
  /** Lowest selectable value. */
  min: number;
  /** Highest selectable value. At most {@link SCALE_MAX_POINTS} points apart —
   *  past that it stops being a row of buttons and wants a number input. */
  max: number;
  /** How the row is drawn. `nps` additionally scores the answers 0–10 in the
   *  results panel (promoters − detractors). */
  style: "stars" | "number" | "nps";
  /** Anchor captions under the two ends ("Not at all" … "Extremely"). */
  minLabel?: string;
  maxLabel?: string;
}

export interface FormBlock {
  /** Stable client id for canvas selection/reorder. Optional; preserved. */
  id?: string;
  /** "field" (default — legacy rows omit it) or the "step" page break. */
  kind?: "field" | "step";
  /** Collection field name — required for field blocks. */
  name?: string;
  /** Display label override; step blocks use it as the step title. */
  label?: string;
  placeholder?: string;
  help?: string;
  /** @deprecated Integer fields only: 1–5 star rating. Superseded by
   *  {@link scale}; still read so existing forms render unchanged. */
  rating?: boolean;
  /** Integer fields only: answer by picking a point on a row. */
  scale?: FormBlockScale;
  /** Boolean fields only: consent checkbox (privacy policy / terms). The
   *  submit is rejected server-side unless the value is exactly `true`. */
  consent?: boolean;
  /** Optional "read the full text" URL rendered next to a consent block. */
  policyUrl?: string;
  /** File blocks only: accepted MIME patterns (`image/*`, `application/pdf`).
   *  Empty/missing ⇒ any type. Enforced server-side at upload time. */
  accept?: string[];
  /** File blocks only: per-upload byte cap. The env-level
   *  `FORM_UPLOAD_MAX_BYTES` ceiling always applies on top. */
  maxBytes?: number;
  cond?: FormBlockCond;
  i18n?: Record<string, FormBlockI18n>;
}

/** Per-locale overrides for the form-level strings. */
export interface FormI18n {
  title?: string;
  description?: string;
  submitLabel?: string;
  successMessage?: string;
}

export interface FormSettings {
  /** Sub-heading under the form title on the public page. */
  description?: string;
  /** Submit button label. Default: "Submit". */
  submitLabel?: string;
  /** Message shown after a successful submission. */
  successMessage?: string;
  /** When set, the public page redirects here after a successful submission. */
  redirectUrl?: string;
  /** Require a Cloudflare Turnstile pass on submit. Needs TURNSTILE_SECRET_KEY. */
  turnstile?: boolean;
  /** Public page appearance. */
  theme?: "dark" | "light";
  accent?: string;
  font?: "sans" | "lexend" | "mono" | "system";
  /** Offered locales, base language first (default ["en"]). Visitors get
   *  their browser language when offered; `?lang=xx` forces one. */
  languages?: string[];
  i18n?: Record<string, FormI18n>;
  /** Epoch ms before which the form does not take answers yet. */
  opensAt?: number;
  /** Epoch ms after which it stops taking them. */
  closesAt?: number;
  /** Stop accepting once this many submissions have been accepted. */
  maxResponses?: number;
  /** One answer per browser — see {@link FORM_ANSWERED_COOKIE_PREFIX}. */
  onePerBrowser?: boolean;
  /** Only a visitor holding an unspent invite may answer (`/f/<token>?i=…`). */
  inviteOnly?: boolean;
  /** What the page says once the form is closed. Falls back to a default. */
  closedMessage?: string;
}

export interface FormRow {
  id: string;
  tenantId: string | null;
  name: string;
  collection: string;
  tokenHash: string;
  fields: FormBlock[];
  settings: FormSettings | null;
  active: boolean;
  submissionCount: number;
  blockedCount: number;
  lastSubmissionAt: Date | number | null;
  createdBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface FormInput {
  name: string;
  collection: string;
  fields: FormBlock[];
  settings?: FormSettings | null;
  active?: boolean;
}

/**
 * True when a collection field may appear on a public form: scalar type, not
 * computed/private/localized, and not server-auto-filled. Presentational
 * types (divider/notice) are excluded implicitly by the type allow-list.
 * `json` fields qualify ONLY when they define choices — that's the
 * multi-select shape (stored as an array of the chosen values).
 */
export const isFormEligible = (f: FieldDef): boolean =>
  (ALLOWED_TYPES.has(f.type) || (f.type === "json" && getChoices(f).length > 0)) &&
  !f.computed &&
  !f.private &&
  !f.localized &&
  !f.onCreate;

/** The collection's form-eligible fields, in schema order. */
export const formEligibleFields = (collection: CollectionRow): FieldDef[] =>
  (collection.fields as FieldDef[]).filter(isFormEligible);

/** Most points a scale row may offer (0–10 inclusive is the widest anyone
 *  actually asks — NPS). Wider than this is a number input wearing buttons. */
export const SCALE_MAX_POINTS = 11;

/**
 * The scale a block renders as, or null when it is an ordinary input.
 *
 * One reader for both spellings so nothing downstream has to remember that
 * `rating: true` predates {@link FormBlockScale} — the public definition, the
 * submit clamp and the results panel all ask this and get the same answer.
 * Only integer fields can carry one; anything else falls back to null rather
 * than rendering a row of buttons that writes a value the column refuses.
 */
export const resolveScale = (
  block: FormBlock,
  def: FieldDef | null | undefined,
): FormBlockScale | null => {
  if (!def || def.type !== "integer") return null;
  if (block.scale) {
    const { min, max, style } = block.scale;
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) return null;
    if (max - min + 1 > SCALE_MAX_POINTS) return null;
    return {
      min,
      max,
      style: style === "nps" ? "nps" : style === "number" ? "number" : "stars",
      ...(block.scale.minLabel ? { minLabel: block.scale.minLabel } : {}),
      ...(block.scale.maxLabel ? { maxLabel: block.scale.maxLabel } : {}),
    };
  }
  if (block.rating) return { min: 1, max: 5, style: "stars" };
  return null;
};

/** Reject a scale a block could not render — said at design time, where the
 *  operator can fix it, rather than silently dropping it at submit time. */
const assertScaleShape = (block: FormBlock, def: FieldDef): void => {
  const s = block.scale;
  if (!s) return;
  const label = block.label || def.label || def.name;
  if (def.type !== "integer") {
    throw new AppError(
      "VALIDATION",
      `"${label}" is a ${def.type} field — a scale needs an integer column to write its answer into`,
    );
  }
  if (!Number.isInteger(s.min) || !Number.isInteger(s.max) || s.max <= s.min) {
    throw new AppError("VALIDATION", `"${label}": a scale needs whole min < max`);
  }
  if (s.max - s.min + 1 > SCALE_MAX_POINTS) {
    throw new AppError(
      "VALIDATION",
      `"${label}": a scale offers at most ${SCALE_MAX_POINTS} points (got ${s.max - s.min + 1})`,
    );
  }
};

/** Throws VALIDATION on a schedule that can never be open. Said at design
 *  time, because the symptom otherwise is a link nobody can use and no error
 *  anywhere that explains why. */
const assertSettingsSane = (settings: FormSettings | null | undefined): void => {
  if (!settings) return;
  const { opensAt, closesAt } = settings;
  if (typeof opensAt === "number" && typeof closesAt === "number" && closesAt <= opensAt) {
    throw new AppError(
      "VALIDATION",
      "The form would close before it opens — set a closing time after the opening one",
    );
  }
};

/** Throws VALIDATION unless every field block references an eligible field. */
const assertFieldsEligible = (
  collection: CollectionRow,
  blocks: FormBlock[],
): void => {
  const fieldBlocks = blocks.filter((b) => (b.kind ?? "field") === "field");
  if (fieldBlocks.length === 0)
    throw new AppError("VALIDATION", "A form needs at least one field");
  const eligibleFields = formEligibleFields(collection);
  const eligible = new Map(eligibleFields.map((f) => [f.name, f]));
  for (const b of fieldBlocks) {
    const def = b.name ? eligible.get(b.name) : undefined;
    if (!def) {
      throw new AppError(
        "VALIDATION",
        `Field "${b.name ?? "?"}" cannot be exposed on a public form (only scalar, non-private, non-computed fields are allowed)`,
      );
    }
    assertScaleShape(b, def);
  }
  // Schema-required fields can't be left off: the write path would reject
  // every submission anyway, so fail loudly at design time instead.
  const present = new Set(fieldBlocks.map((b) => b.name));
  for (const f of eligibleFields) {
    if (f.required && !present.has(f.name)) {
      throw new AppError(
        "VALIDATION",
        `Required field "${f.name}" must be on the form — submissions would always fail without it`,
      );
    }
  }
};

const tenantScope = (t: any, tenantId: string | null) =>
  tenantId ? or(eq(t.tenantId, tenantId), isNull(t.tenantId)) : isNull(t.tenantId);

/** Coerce a raw DB row into the API shape (sqlite 0/1 → boolean, null counts). */
const normalizeRow = (r: any): FormRow => ({
  ...r,
  active: Boolean(r.active),
  submissionCount: Number(r.submissionCount ?? 0),
  blockedCount: Number(r.blockedCount ?? 0),
  fields: Array.isArray(r.fields) ? r.fields : [],
});

export const listForms = async (
  ctx: Ctx,
  tenantId: string | null,
): Promise<FormRow[]> => {
  const t = formTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(tenantScope(t, tenantId))
      .orderBy(desc(t.createdAt))) as any[];
    return rows.map(normalizeRow);
  } catch {
    return [];
  }
};

export const getForm = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
): Promise<FormRow | null> => {
  const t = formTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.id, id), tenantScope(t, tenantId)))
      .limit(1)) as any[];
    return rows[0] ? normalizeRow(rows[0]) : null;
  } catch {
    return null;
  }
};

/**
 * Mint a new form. Validates the target collection exists and every exposed
 * field is form-eligible. Returns the row plus the one-time plaintext token.
 */
export const createForm = async (
  ctx: Ctx,
  input: FormInput & { tenantId: string | null; createdBy: string | null },
): Promise<{ row: FormRow; token: string }> => {
  const collection = await loadCollection(ctx, input.tenantId, input.collection);
  assertFieldsEligible(collection, input.fields);
  assertSettingsSane(input.settings);

  const token = `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const tokenHash = await hashToken(token);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const row: FormRow = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    name: input.name,
    collection: collection.slug,
    tokenHash,
    fields: input.fields,
    settings: input.settings ?? null,
    active: input.active ?? true,
    submissionCount: 0,
    blockedCount: 0,
    lastSubmissionAt: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(formTable(ctx.dialect)).values(row);
  return { row, token };
};

export const updateForm = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
  patch: Partial<FormInput>,
): Promise<FormRow> => {
  const existing = await getForm(ctx, tenantId, id);
  if (!existing) throw new AppError("NOT_FOUND", "Form not found");

  const collectionSlug = patch.collection ?? existing.collection;
  const fields = patch.fields ?? existing.fields;
  // Re-validate whenever the target collection or the block set changes.
  if (patch.collection !== undefined || patch.fields !== undefined) {
    const collection = await loadCollection(ctx, tenantId, collectionSlug);
    assertFieldsEligible(collection, fields);
  }
  if (patch.settings !== undefined) assertSettingsSane(patch.settings);

  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const next: Record<string, unknown> = { updatedAt: now };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.collection !== undefined) next.collection = collectionSlug;
  if (patch.fields !== undefined) next.fields = fields;
  if (patch.settings !== undefined) next.settings = patch.settings;
  if (patch.active !== undefined) next.active = patch.active;

  const t = formTable(ctx.dialect);
  await (ctx.db as any).update(t).set(next).where(eq(t.id, id));
  return { ...existing, ...next } as FormRow;
};

export const deleteForm = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
): Promise<void> => {
  const existing = await getForm(ctx, tenantId, id);
  if (!existing) throw new AppError("NOT_FOUND", "Form not found");
  const t = formTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};

/** Replace the form's token. Returns the new one-time plaintext token. */
export const rotateFormToken = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
): Promise<{ row: FormRow; token: string }> => {
  const existing = await getForm(ctx, tenantId, id);
  if (!existing) throw new AppError("NOT_FOUND", "Form not found");
  const token = `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const tokenHash = await hashToken(token);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const t = formTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({ tokenHash, updatedAt: now })
    .where(eq(t.id, id));
  return { row: { ...existing, tokenHash, updatedAt: now }, token };
};

/**
 * Resolve a plaintext token to its form row — ACTIVE OR PAUSED (callers map
 * paused to 410 so embedders can tell "switched off" from "never existed").
 * Null when unknown or the table hasn't been migrated yet.
 */
export const resolveFormToken = async (
  ctx: Ctx,
  token: string,
): Promise<FormRow | null> => {
  if (!token || !token.startsWith(`${TOKEN_PREFIX}_`)) return null;
  const tokenHash = await hashToken(token);
  const t = formTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tokenHash, tokenHash))
      .limit(1)) as any[];
    return rows[0] ? normalizeRow(rows[0]) : null;
  } catch {
    return null;
  }
};

/** Best-effort submission counters — never allowed to fail the request. */
export const recordFormSubmission = async (ctx: Ctx, id: string): Promise<void> => {
  const t = formTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  try {
    await (ctx.db as any)
      .update(t)
      .set({
        submissionCount: sql`${t.submissionCount} + 1`,
        lastSubmissionAt: now,
      })
      .where(eq(t.id, id));
  } catch {
    // Counter loss is acceptable; the row write already succeeded.
  }
};

export const recordFormBlocked = async (ctx: Ctx, id: string): Promise<void> => {
  const t = formTable(ctx.dialect);
  try {
    await (ctx.db as any)
      .update(t)
      .set({ blockedCount: sql`${t.blockedCount} + 1` })
      .where(eq(t.id, id));
  } catch {
    // Best-effort.
  }
};

/* ── Public definition ─────────────────────────────────────────────── */

/** Public metadata for one block — everything the form page needs to render,
 *  and nothing else (no conditions on hidden internals, no storage details). */
export interface PublicFormBlock {
  kind: string;
  /** Field name (field blocks) — absent on step blocks. */
  name?: string;
  /** Storage type of the underlying field (field blocks). */
  type?: string;
  label: string;
  placeholder: string | null;
  help: string | null;
  required: boolean;
  /** @deprecated True when {@link scale} is the legacy 1–5 star row. Kept in
   *  the payload so a page bundle cached across a deploy still renders stars
   *  instead of a bare number input. */
  rating: boolean;
  /** Non-null ⇒ answer by picking a point on a row. */
  scale: FormBlockScale | null;
  consent: boolean;
  policyUrl: string | null;
  choices: Array<{ value: string; label?: string }> | null;
  /** File blocks: accepted MIME patterns (null ⇒ any) and the effective
   *  per-upload byte cap (block config clamped by the env ceiling). */
  accept: string[] | null;
  maxBytes: number | null;
  validation: {
    regex?: string;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    format?: "email" | "url";
    integer?: boolean;
    minSelect?: number;
    maxSelect?: number;
  } | null;
  cond: FormBlockCond | null;
}

export interface PublicFormDefinition {
  name: string;
  description: string | null;
  collection: string;
  blocks: PublicFormBlock[];
  submitLabel: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
  theme: "dark" | "light";
  accent: string | null;
  font: "sans" | "lexend" | "mono" | "system";
  /** Offered locales, base first; `locale` is the one this payload resolved. */
  languages: string[];
  locale: string;
  /** Non-null ⇒ the page must render the Turnstile widget with this site key. */
  turnstileSiteKey: string | null;
  /** Non-null ⇒ the form is not taking answers; render this in place of the
   *  questions. The blocks are still sent so the page keeps its shape. */
  closed: { reason: FormClosedReason; message: string } | null;
}

/**
 * The exposed field-block set, re-derived against the CURRENT collection
 * schema — the stored config is intersected with today's eligible fields, so
 * a field that was dropped or became ineligible silently disappears from the
 * form. Used by both the public GET (render) and the submit clamp.
 */
export const exposedBlocks = (
  form: FormRow,
  collection: CollectionRow,
): Array<{ block: FormBlock; def: FieldDef | null }> => {
  const byName = new Map(formEligibleFields(collection).map((f) => [f.name, f]));
  const out: Array<{ block: FormBlock; def: FieldDef | null }> = [];
  for (const block of form.fields) {
    const kind = block.kind ?? "field";
    if (kind === "step") {
      out.push({ block, def: null });
      continue;
    }
    const def = block.name ? byName.get(block.name) : undefined;
    if (def) out.push({ block, def });
  }
  return out;
};

/** The submit clamp: names of the currently-exposed field blocks. */
export const exposedFieldNames = (
  form: FormRow,
  collection: CollectionRow,
): Set<string> =>
  new Set(
    exposedBlocks(form, collection)
      .filter((e) => e.def)
      .map((e) => e.def!.name),
  );

/* ── Availability ──────────────────────────────────────────────────── */

/** Why a form is not taking answers right now. `open` is the only state that
 *  accepts a submit. */
export type FormClosedReason =
  | "scheduled"
  | "ended"
  | "full"
  | "answered"
  /** Invite-only, and this visitor arrived without a usable one. */
  | "invite"
  /** The invite they arrived with has already been spent. */
  | "invite_used";

export interface FormAvailability {
  open: boolean;
  reason: FormClosedReason | null;
  /** The line the page shows in place of the questions. */
  message: string | null;
}

/** Default wording per reason, when the operator hasn't written their own. */
const CLOSED_MESSAGES: Record<FormClosedReason, string> = {
  scheduled: "This form isn't open yet.",
  ended: "This form is closed.",
  full: "This form has reached its response limit.",
  answered: "You've already answered this form.",
  invite: "This form is open to invited people only — use the link you were sent.",
  invite_used: "This invitation has already been used.",
};

/**
 * Whether a form is taking answers, and if not, why.
 *
 * Deliberately NOT the same thing as `active`. A paused form answers 410
 * everywhere and says nothing else — it is switched off, and the visitor is
 * not supposed to have a link to it. A form that has closed on its own terms
 * still renders: it has a title, and "this closed on Friday" is the answer the
 * person following the link came for. A 404 in its place reads as a broken
 * link and produces a support ticket.
 *
 * The cap is checked against the accepted-submission counter, so it is enforced
 * BEFORE the row is written. A burst of simultaneous submits can therefore land
 * a couple over the limit; the alternative — reserving a slot in the same
 * statement that increments the counter — would count every submission that
 * then failed validation against the cap, which is the worse mistake for a
 * survey nobody can re-open.
 */
export const formAvailability = (
  form: FormRow,
  now: number,
  opts: {
    alreadyAnswered?: boolean;
    /** What is wrong with the invite this visitor arrived with, if the form is
     *  invite-only. `null`/absent means a usable one (or an open form). */
    inviteProblem?: "missing" | "unknown" | "used" | null;
  } = {},
): FormAvailability => {
  const s = form.settings ?? {};
  const closed = (reason: FormClosedReason): FormAvailability => ({
    open: false,
    reason,
    // The operator's own wording covers the form being over. It does NOT cover
    // an invite problem: "voting closed on Friday" in front of someone whose
    // colleague already used their link is a wrong answer, not a polite one.
    message:
      reason === "invite" || reason === "invite_used"
        ? CLOSED_MESSAGES[reason]
        : s.closedMessage || CLOSED_MESSAGES[reason],
  });
  if (typeof s.opensAt === "number" && now < s.opensAt) return closed("scheduled");
  if (typeof s.closesAt === "number" && now >= s.closesAt) return closed("ended");
  if (typeof s.maxResponses === "number" && form.submissionCount >= s.maxResponses)
    return closed("full");
  if (s.inviteOnly && opts.inviteProblem) {
    return closed(opts.inviteProblem === "used" ? "invite_used" : "invite");
  }
  // "Already answered" is last: a form that is closed anyway should say so
  // rather than tell someone they answered a form nobody can answer.
  if (opts.alreadyAnswered && s.onePerBrowser) return closed("answered");
  return { open: true, reason: null, message: null };
};

/**
 * Name of the cookie that remembers a browser answered this form.
 *
 * Keyed by a hash of the form ID, not the ID itself: the ID is not public and a
 * cookie is the one place a page hands its own storage to whoever is looking.
 * Hashing the ID rather than the TOKEN also means rotating the public link does
 * not hand everyone a second answer.
 *
 * What it is NOT is identity. Clearing cookies, another browser or a private
 * window all get a second answer, and the admin toggle says so — for a survey
 * that must count people once, use invite links.
 */
export const FORM_ANSWERED_COOKIE_PREFIX = "blx_fa_";

export const formAnsweredCookieName = async (formId: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(formId));
  const hex = Array.from(new Uint8Array(digest).slice(0, 6), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${FORM_ANSWERED_COOKIE_PREFIX}${hex}`;
};

/** Resolve the payload locale: `?lang=` wins when offered, else the base. */
export const resolveFormLocale = (form: FormRow, lang: string | null): string => {
  const languages = form.settings?.languages?.length ? form.settings.languages : ["en"];
  const base = languages[0] ?? "en";
  if (lang && languages.includes(lang)) return lang;
  return base;
};

/** Default + ceiling for one anonymous form upload when the env doesn't say
 *  otherwise (`FORM_UPLOAD_MAX_BYTES`). Lives here so `form-uploads.ts` and
 *  the definition builder agree without a circular import. */
export const FORM_UPLOAD_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Build the public definition payload for the form page. */
export const publicFormDefinition = (
  form: FormRow,
  collection: CollectionRow,
  turnstileSiteKey: string | null,
  lang: string | null = null,
  uploadMaxBytes: number = FORM_UPLOAD_DEFAULT_MAX_BYTES,
  availability: FormAvailability = { open: true, reason: null, message: null },
): PublicFormDefinition => {
  const settings = form.settings ?? {};
  const languages = settings.languages?.length ? settings.languages : ["en"];
  const base = languages[0] ?? "en";
  const locale = resolveFormLocale(form, lang);
  const formI18n = locale !== base ? (settings.i18n?.[locale] ?? {}) : {};

  const blocks = exposedBlocks(form, collection).map(
    ({ block, def }): PublicFormBlock => {
      const blockI18n = locale !== base ? (block.i18n?.[locale] ?? {}) : {};
      if (!def) {
        return {
          kind: "step",
          label: blockI18n.label || block.label || "",
          placeholder: null,
          help: null,
          required: false,
          rating: false,
          scale: null,
          consent: false,
          policyUrl: null,
          choices: null,
          accept: null,
          maxBytes: null,
          validation: null,
          cond: block.cond ?? null,
        };
      }
      const v = def.validation;
      const validation = v
        ? {
            ...(v.regex !== undefined ? { regex: v.regex } : {}),
            ...(v.min !== undefined ? { min: v.min } : {}),
            ...(v.max !== undefined ? { max: v.max } : {}),
            ...(v.minLength !== undefined ? { minLength: v.minLength } : {}),
            ...(v.maxLength !== undefined ? { maxLength: v.maxLength } : {}),
            ...(v.format !== undefined ? { format: v.format } : {}),
            ...(v.integer !== undefined ? { integer: v.integer } : {}),
            ...(v.minSelect !== undefined ? { minSelect: v.minSelect } : {}),
            ...(v.maxSelect !== undefined ? { maxSelect: v.maxSelect } : {}),
          }
        : null;
      const choices = getChoices(def);
      const consent = Boolean(block.consent && def.type === "boolean");
      const isFile = def.type === "file";
      const scale = resolveScale(block, def);
      return {
        kind: "field",
        name: def.name,
        type: def.type,
        label: blockI18n.label || block.label || def.label || def.name,
        placeholder: blockI18n.placeholder || block.placeholder || null,
        help: blockI18n.help || block.help || def.description || null,
        // A consent checkbox is inherently required — unchecked can't submit.
        required: Boolean(def.required) || consent,
        rating: scale?.style === "stars" && scale.min === 1 && scale.max === 5,
        scale,
        consent,
        policyUrl: consent ? (block.policyUrl ?? null) : null,
        choices: choices.length > 0 ? choices : null,
        accept: isFile && block.accept?.length ? block.accept : null,
        maxBytes: isFile
          ? Math.min(block.maxBytes || uploadMaxBytes, uploadMaxBytes)
          : null,
        validation:
          validation && Object.keys(validation).length > 0 ? validation : null,
        cond: block.cond ?? null,
      };
    },
  );

  return {
    name: formI18n.title || form.name,
    description: formI18n.description || settings.description || null,
    collection: form.collection,
    blocks,
    submitLabel: formI18n.submitLabel || settings.submitLabel || null,
    successMessage: formI18n.successMessage || settings.successMessage || null,
    redirectUrl: settings.redirectUrl ?? null,
    theme: settings.theme === "light" ? "light" : "dark",
    accent: settings.accent ?? null,
    font:
      settings.font === "lexend" || settings.font === "mono" || settings.font === "system"
        ? settings.font
        : "sans",
    languages,
    locale,
    turnstileSiteKey: settings.turnstile ? turnstileSiteKey : null,
    closed:
      availability.open || !availability.reason
        ? null
        : { reason: availability.reason, message: availability.message ?? "" },
  };
};

/**
 * Enforce consent blocks on a clamped submit payload: every exposed consent
 * checkbox must be exactly `true`. Runs server-side so a hand-crafted POST
 * can't skip the checkbox the page renders.
 */
export const assertConsents = (
  form: FormRow,
  collection: CollectionRow,
  data: Record<string, unknown>,
): void => {
  for (const { block, def } of exposedBlocks(form, collection)) {
    if (!def || !block.consent || def.type !== "boolean") continue;
    if (data[def.name] !== true) {
      throw new AppError(
        "VALIDATION",
        `Consent required: "${block.label || def.label || def.name}" must be accepted`,
      );
    }
  }
};

/**
 * Hold a scale answer to the row it was offered on.
 *
 * The page can only send a point it drew, but the endpoint is public and a
 * hand-written POST is not the page. Without this an NPS column quietly
 * collects 47s and every average computed from it is wrong — the field's own
 * `validation.min/max` is optional and, for a scale that only exists on the
 * form, is not where an operator would think to write the bound.
 */
export const assertScales = (
  form: FormRow,
  collection: CollectionRow,
  data: Record<string, unknown>,
): void => {
  for (const { block, def } of exposedBlocks(form, collection)) {
    if (!def) continue;
    const scale = resolveScale(block, def);
    if (!scale) continue;
    const raw = data[def.name];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < scale.min || n > scale.max) {
      throw new AppError(
        "VALIDATION",
        `"${block.label || def.label || def.name}" must be a whole number between ${scale.min} and ${scale.max}`,
      );
    }
  }
};

/**
 * Server-side Turnstile verification. Fail-closed: a form with turnstile
 * enabled but no configured secret rejects every submit with a clear error
 * rather than silently skipping the check.
 */
export const verifyTurnstile = async (
  secret: string | undefined,
  token: string | undefined,
  ip: string | null,
): Promise<void> => {
  if (!secret) {
    throw new AppError(
      "VALIDATION",
      "This form requires Turnstile but the server has no TURNSTILE_SECRET_KEY configured",
    );
  }
  if (!token) {
    throw new AppError("VALIDATION", "Turnstile verification is required");
  }
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    },
  );
  const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
  if (!body?.success) {
    throw new AppError("VALIDATION", "Turnstile verification failed — please retry the challenge");
  }
};
