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
 * v1 scope fence: only scalar field types (text/longtext/integer/number/
 * boolean/timestamp — dropdowns are `text` + choices) can be exposed. Relation/
 * file/hash/json/localized/computed/private/auto-filled fields are rejected at
 * definition time AND re-filtered at read/submit time, so a stale form
 * definition can never leak or write a field that later became ineligible.
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

/** Field types a form may expose. Dropdowns are `text` + `options.choices`. */
const ALLOWED_TYPES = new Set<string>([
  "text",
  "longtext",
  "integer",
  "number",
  "boolean",
  "timestamp",
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
  /** Integer fields only: render as a 1–5 star rating on the public page. */
  rating?: boolean;
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
 */
export const isFormEligible = (f: FieldDef): boolean =>
  ALLOWED_TYPES.has(f.type) &&
  !f.computed &&
  !f.private &&
  !f.localized &&
  !f.onCreate;

/** The collection's form-eligible fields, in schema order. */
export const formEligibleFields = (collection: CollectionRow): FieldDef[] =>
  (collection.fields as FieldDef[]).filter(isFormEligible);

/** Throws VALIDATION unless every field block references an eligible field. */
const assertFieldsEligible = (
  collection: CollectionRow,
  blocks: FormBlock[],
): void => {
  const fieldBlocks = blocks.filter((b) => (b.kind ?? "field") === "field");
  if (fieldBlocks.length === 0)
    throw new AppError("VALIDATION", "A form needs at least one field");
  const eligible = new Set(formEligibleFields(collection).map((f) => f.name));
  for (const b of fieldBlocks) {
    if (!b.name || !eligible.has(b.name)) {
      throw new AppError(
        "VALIDATION",
        `Field "${b.name ?? "?"}" cannot be exposed on a public form (only scalar, non-private, non-computed fields are allowed)`,
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
  rating: boolean;
  choices: Array<{ value: string; label?: string }> | null;
  validation: {
    regex?: string;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    format?: "email" | "url";
    integer?: boolean;
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

/** Resolve the payload locale: `?lang=` wins when offered, else the base. */
export const resolveFormLocale = (form: FormRow, lang: string | null): string => {
  const languages = form.settings?.languages?.length ? form.settings.languages : ["en"];
  const base = languages[0] ?? "en";
  if (lang && languages.includes(lang)) return lang;
  return base;
};

/** Build the public definition payload for the form page. */
export const publicFormDefinition = (
  form: FormRow,
  collection: CollectionRow,
  turnstileSiteKey: string | null,
  lang: string | null = null,
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
          choices: null,
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
          }
        : null;
      const choices = getChoices(def);
      return {
        kind: "field",
        name: def.name,
        type: def.type,
        label: blockI18n.label || block.label || def.label || def.name,
        placeholder: blockI18n.placeholder || block.placeholder || null,
        help: blockI18n.help || block.help || def.description || null,
        required: Boolean(def.required),
        rating: Boolean(block.rating && def.type === "integer"),
        choices: choices.length > 0 ? choices : null,
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
  };
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
