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
 * v1 scope fence: only scalar field types (text/longtext/integer/number/
 * boolean/timestamp — dropdowns are `text` + choices) can be exposed on a
 * form. Relation/file/hash/json/localized/computed/private/auto-filled fields
 * are rejected at definition time AND re-filtered at read/submit time, so a
 * stale form definition can never leak or write a field that later became
 * ineligible.
 */
import { and, desc, eq, isNull, or } from "drizzle-orm";
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

export interface FormFieldConfig {
  /** Collection field name — must be form-eligible at definition time. */
  name: string;
  /** Display label override; falls back to the field's own label/name. */
  label?: string;
  /** Help text override shown beneath the input. */
  help?: string;
}

export interface FormSettings {
  /** Submit button label. Default: "Submit". */
  submitLabel?: string;
  /** Message shown after a successful submission. */
  successMessage?: string;
  /** When set, the public page redirects here after a successful submission. */
  redirectUrl?: string;
  /** Require a Cloudflare Turnstile pass on submit. Needs TURNSTILE_SECRET_KEY. */
  turnstile?: boolean;
}

export interface FormRow {
  id: string;
  tenantId: string | null;
  name: string;
  collection: string;
  tokenHash: string;
  fields: FormFieldConfig[];
  settings: FormSettings | null;
  active: boolean;
  createdBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface FormInput {
  name: string;
  collection: string;
  fields: FormFieldConfig[];
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

/** Throws VALIDATION unless every configured field is eligible right now. */
const assertFieldsEligible = (
  collection: CollectionRow,
  fields: FormFieldConfig[],
): void => {
  if (fields.length === 0)
    throw new AppError("VALIDATION", "A form needs at least one field");
  const eligible = new Set(formEligibleFields(collection).map((f) => f.name));
  for (const f of fields) {
    if (!eligible.has(f.name)) {
      throw new AppError(
        "VALIDATION",
        `Field "${f.name}" cannot be exposed on a public form (only scalar, non-private, non-computed fields are allowed)`,
      );
    }
  }
};

const tenantScope = (t: any, tenantId: string | null) =>
  tenantId ? or(eq(t.tenantId, tenantId), isNull(t.tenantId)) : isNull(t.tenantId);

export const listForms = async (
  ctx: Ctx,
  tenantId: string | null,
): Promise<FormRow[]> => {
  const t = formTable(ctx.dialect);
  try {
    return (await (ctx.db as any)
      .select()
      .from(t)
      .where(tenantScope(t, tenantId))
      .orderBy(desc(t.createdAt))) as FormRow[];
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
      .limit(1)) as FormRow[];
    return rows[0] ?? null;
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
  // Re-validate whenever the target collection or the field set changes.
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
 * Resolve a plaintext token to its ACTIVE form row. Null when unknown,
 * inactive, or the table hasn't been migrated yet.
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
      .limit(1)) as FormRow[];
    const row = rows[0];
    if (!row || !row.active) return null;
    return row;
  } catch {
    return null;
  }
};

/** Public metadata for one exposed field — everything the form page needs to
 *  render an input, and nothing else (no conditions, no storage details). */
export interface PublicFormField {
  name: string;
  type: string;
  label: string;
  help: string | null;
  required: boolean;
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
}

export interface PublicFormDefinition {
  name: string;
  collection: string;
  fields: PublicFormField[];
  submitLabel: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
  /** Non-null ⇒ the page must render the Turnstile widget with this site key. */
  turnstileSiteKey: string | null;
}

/**
 * The exposed field set, re-derived against the CURRENT collection schema —
 * the stored config is intersected with today's eligible fields, so a field
 * that was dropped or became ineligible silently disappears from the form.
 * Used by both the public GET (render) and the submit clamp.
 */
export const exposedFields = (
  form: FormRow,
  collection: CollectionRow,
): Array<{ def: FieldDef; config: FormFieldConfig }> => {
  const byName = new Map(
    formEligibleFields(collection).map((f) => [f.name, f]),
  );
  const out: Array<{ def: FieldDef; config: FormFieldConfig }> = [];
  for (const config of form.fields) {
    const def = byName.get(config.name);
    if (def) out.push({ def, config });
  }
  return out;
};

/** Build the public definition payload for the form page. */
export const publicFormDefinition = (
  form: FormRow,
  collection: CollectionRow,
  turnstileSiteKey: string | null,
): PublicFormDefinition => {
  const settings = form.settings ?? {};
  const fields = exposedFields(form, collection).map(({ def, config }): PublicFormField => {
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
      name: def.name,
      type: def.type,
      label: config.label ?? def.label ?? def.name,
      help: config.help ?? def.description ?? null,
      required: Boolean(def.required),
      choices: choices.length > 0 ? choices : null,
      validation: validation && Object.keys(validation).length > 0 ? validation : null,
    };
  });
  return {
    name: form.name,
    collection: form.collection,
    fields,
    submitLabel: settings.submitLabel ?? null,
    successMessage: settings.successMessage ?? null,
    redirectUrl: settings.redirectUrl ?? null,
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
