/**
 * Tag manager — draft CRUD, and the compile/publish step that turns a draft
 * into the artifact a visitor's browser actually receives.
 *
 * ── The one idea this file is built around ────────────────────────────────
 * Drafts and what is served are different things. The `tag_*` tables hold what
 * an operator is editing; `tag_versions` holds an immutable COMPILED artifact,
 * and `analytics_sites.published_version_id` points at whichever one is live.
 * Publishing compiles; it does not flip a flag. Rolling back moves the pointer;
 * it does not re-derive anything.
 *
 * That split buys three things worth the extra table:
 *
 *  - **Serving is one query.** The route that every visitor hits reads a
 *    finished JSON document, and never re-runs validation or joins three
 *    tables while a page is blocked on it.
 *  - **A rollback reproduces what was live**, byte for byte — not what today's
 *    compiler would make of yesterday's rows.
 *  - **Editing is never live.** An operator can leave a tag half-configured
 *    without a customer's site changing under them.
 *
 * ── Everything is re-validated at COMPILE time ────────────────────────────
 * Not just on write. A template can tighten, a row can be edited around the
 * API, and — the case that actually matters — `allow_custom_code` can be
 * switched OFF after custom tags already exist. Enforcing the gate only on
 * write would leave those tags firing forever. So compile drops anything that
 * no longer validates, and reports what it dropped rather than failing the
 * publish: one broken tag must not stop an operator shipping the other nine.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { hashToken } from "./shared-links";
import {
  CONSENT_CATEGORIES,
  type ConsentCategory,
  getTagTemplate,
  parseTemplateParams,
} from "./tag-templates";
import {
  type TagConditionNode,
  type TriggerConfig,
  parseTagCondition,
  parseTriggerConfig,
} from "./tag-conditions";

export interface TagDbCtx {
  db: unknown;
  dialect: "pg" | "sqlite";
}

const sitesTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.analyticsSites : sqlite.schema.analyticsSites;
const varsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.tagVariables : sqlite.schema.tagVariables;
const triggersTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.tagTriggers : sqlite.schema.tagTriggers;
const tagsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.tagDefinitions : sqlite.schema.tagDefinitions;
const versionsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.tagVersions : sqlite.schema.tagVersions;

const tenantEq = (col: any, tenantId: string | null) =>
  tenantId === null ? isNull(col) : eq(col, tenantId);

const tsValue = (v: unknown): number =>
  v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v ?? 0);

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

const strArray = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, max)
    : [];

/** How many of each an operator may create per site. Generous for a human,
 *  bounded so one workspace cannot make the container endpoint expensive. */
const MAX_PER_SITE = 200;

/**
 * Confirm the site belongs to this workspace before anything is written
 * against it.
 *
 * Every query below is already tenant-scoped, so a cross-tenant READ is
 * impossible without this. What it stops is subtler: writing a row that
 * carries YOUR tenant id but SOMEONE ELSE'S site id. Nothing would leak — the
 * publish step is tenant-scoped too, so the foreign site's pointer would never
 * move — but the rows would be orphaned garbage attached to another
 * workspace's site, and the failure would surface much later as "my tag does
 * not fire". Refusing up front is cheaper to understand.
 */
const assertSiteOwned = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
): Promise<void> => {
  const t = sitesTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, siteId), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!row) throw new AppError("NOT_FOUND", "Site not found.");
};

const assertUnder = async (
  ctx: TagDbCtx,
  table: any,
  tenantId: string | null,
  siteId: string,
  what: string,
): Promise<void> => {
  const [row] = (await (ctx.db as any)
    .select({ n: sql<number>`count(*)` })
    .from(table)
    .where(and(eq(table.siteId, siteId), tenantEq(table.tenantId, tenantId)))) as any[];
  if (Number(row?.n ?? 0) >= MAX_PER_SITE) {
    throw new AppError("VALIDATION", `A site may hold at most ${MAX_PER_SITE} ${what}.`);
  }
};

// ── Variables ─────────────────────────────────────────────────────────────

export interface TagVariableRow {
  id: string;
  siteId: string;
  key: string;
  name: string;
  kind: string;
  config: unknown;
  createdAt: number;
  updatedAt: number;
}

export const VARIABLE_KINDS = [
  "constant",
  "query_param",
  "cookie",
  "data_layer",
  "js_expression",
] as const;
export type VariableKind = (typeof VARIABLE_KINDS)[number];

const toVariable = (r: any): TagVariableRow => ({
  id: r.id,
  siteId: r.siteId,
  key: r.key,
  name: r.name,
  kind: r.kind,
  config: r.config ?? null,
  createdAt: tsValue(r.createdAt),
  updatedAt: tsValue(r.updatedAt),
});

/** A variable key is what an operator types as `{{key}}`, so it is bounded to
 *  what a key can legally be rather than to arbitrary text. */
const VARIABLE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const parseVariableConfig = (kind: string, input: unknown): unknown => {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  switch (kind) {
    case "constant":
      return { value: str(raw.value, 500) ?? "" };
    case "query_param":
    case "cookie":
    case "data_layer": {
      // One field for all three, and it is the same shape in each: the name of
      // the thing to read off the page.
      const name = str(raw.name, 120);
      if (!name) throw new AppError("VALIDATION", "This variable needs a name to read.");
      return { name };
    }
    case "js_expression": {
      const code = str(raw.code, 4000);
      if (!code) throw new AppError("VALIDATION", "A JavaScript variable needs an expression.");
      return { code };
    }
    default:
      throw new AppError("VALIDATION", `Unknown variable kind. Allowed: ${VARIABLE_KINDS.join(", ")}.`);
  }
};

export const listVariables = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
): Promise<TagVariableRow[]> => {
  const t = varsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.siteId, siteId), tenantEq(t.tenantId, tenantId)))
    .orderBy(t.key)) as any[];
  return rows.map(toVariable);
};

export const createVariable = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
  input: { key?: unknown; name?: unknown; kind?: unknown; config?: unknown },
  now = Date.now(),
): Promise<TagVariableRow> => {
  await assertSiteOwned(ctx, tenantId, siteId);
  const t = varsTable(ctx.dialect);
  await assertUnder(ctx, t, tenantId, siteId, "variables");

  const key = str(input.key, 64) ?? "";
  if (!VARIABLE_KEY.test(key)) {
    throw new AppError(
      "VALIDATION",
      "A variable key must start with a letter and hold only letters, digits and underscores.",
    );
  }
  const kind = str(input.kind, 32) ?? "constant";
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    siteId,
    key,
    name: str(input.name, 120) ?? key,
    kind,
    config: parseVariableConfig(kind, input.config),
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  await (ctx.db as any).insert(t).values(row);
  return toVariable(row);
};

export const updateVariable = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  id: string,
  input: { key?: unknown; name?: unknown; kind?: unknown; config?: unknown },
  now = Date.now(),
): Promise<TagVariableRow> => {
  const t = varsTable(ctx.dialect);
  const [existing] = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!existing) throw new AppError("NOT_FOUND", "Variable not found.");

  const kind = input.kind !== undefined ? (str(input.kind, 32) ?? "constant") : existing.kind;
  const patch: Record<string, unknown> = { updatedAt: new Date(now), kind };
  if (input.key !== undefined) {
    const key = str(input.key, 64) ?? "";
    if (!VARIABLE_KEY.test(key)) {
      throw new AppError("VALIDATION", "A variable key must be a plain identifier.");
    }
    patch.key = key;
  }
  if (input.name !== undefined) patch.name = str(input.name, 120) ?? existing.name;
  // The config is re-parsed against the RESULTING kind, not the stored one —
  // otherwise changing kind and config together would validate the new config
  // against the old rules.
  if (input.config !== undefined || input.kind !== undefined) {
    patch.config = parseVariableConfig(kind, input.config ?? existing.config);
  }

  await (ctx.db as any)
    .update(t)
    .set(patch)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));
  return toVariable({ ...existing, ...patch });
};

export const deleteVariable = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  id: string,
): Promise<void> => {
  const t = varsTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));
};

// ── Triggers ──────────────────────────────────────────────────────────────

export interface TagTriggerRow {
  id: string;
  siteId: string;
  name: string;
  type: string;
  config: unknown;
  condition: unknown;
  createdAt: number;
  updatedAt: number;
}

const toTrigger = (r: any): TagTriggerRow => ({
  id: r.id,
  siteId: r.siteId,
  name: r.name,
  type: r.type,
  config: r.config ?? null,
  condition: r.condition ?? null,
  createdAt: tsValue(r.createdAt),
  updatedAt: tsValue(r.updatedAt),
});

export const listTriggers = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
): Promise<TagTriggerRow[]> => {
  const t = triggersTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.siteId, siteId), tenantEq(t.tenantId, tenantId)))
    .orderBy(t.name)) as any[];
  return rows.map(toTrigger);
};

export const createTrigger = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
  input: { name?: unknown; type?: unknown; config?: unknown; condition?: unknown },
  now = Date.now(),
): Promise<TagTriggerRow> => {
  await assertSiteOwned(ctx, tenantId, siteId);
  const t = triggersTable(ctx.dialect);
  await assertUnder(ctx, t, tenantId, siteId, "triggers");

  const type = str(input.type, 32) ?? "";
  // Validated here so a bad trigger is refused at the point the operator can
  // still see why, rather than silently dropped at publish.
  parseTriggerConfig(type, input.config);
  const condition = input.condition == null ? null : parseTagCondition(input.condition);

  const row = {
    id: crypto.randomUUID(),
    tenantId,
    siteId,
    name: str(input.name, 120) ?? type,
    type,
    config: input.config ?? null,
    condition,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  await (ctx.db as any).insert(t).values(row);
  return toTrigger(row);
};

export const updateTrigger = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  id: string,
  input: { name?: unknown; type?: unknown; config?: unknown; condition?: unknown },
  now = Date.now(),
): Promise<TagTriggerRow> => {
  const t = triggersTable(ctx.dialect);
  const [existing] = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!existing) throw new AppError("NOT_FOUND", "Trigger not found.");

  const type = input.type !== undefined ? (str(input.type, 32) ?? "") : existing.type;
  const config = input.config !== undefined ? input.config : existing.config;
  parseTriggerConfig(type, config);

  const patch: Record<string, unknown> = { updatedAt: new Date(now), type, config };
  if (input.name !== undefined) patch.name = str(input.name, 120) ?? existing.name;
  if (input.condition !== undefined) {
    patch.condition = input.condition == null ? null : parseTagCondition(input.condition);
  }

  await (ctx.db as any)
    .update(t)
    .set(patch)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));
  return toTrigger({ ...existing, ...patch });
};

export const deleteTrigger = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  id: string,
): Promise<void> => {
  const t = triggersTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));
};

// ── Tags ──────────────────────────────────────────────────────────────────

export const TAG_KINDS = [
  "template",
  "custom_html",
  "custom_js",
  "image_pixel",
  "backlex_event",
] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const FIRE_RULES = ["always", "once_per_page", "once_per_visitor_day"] as const;

/** Kinds that run operator-authored code, and therefore ride the per-site gate. */
export const CUSTOM_CODE_KINDS: readonly string[] = ["custom_html", "custom_js"];

export interface TagDefinitionRow {
  id: string;
  siteId: string;
  name: string;
  kind: string;
  templateId: string | null;
  params: unknown;
  triggerIds: string[];
  blockingTriggerIds: string[];
  consentCategory: string;
  fireRule: string;
  priority: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const toTag = (r: any): TagDefinitionRow => ({
  id: r.id,
  siteId: r.siteId,
  name: r.name,
  kind: r.kind,
  templateId: r.templateId ?? null,
  params: r.params ?? null,
  triggerIds: Array.isArray(r.triggerIds) ? r.triggerIds : [],
  blockingTriggerIds: Array.isArray(r.blockingTriggerIds) ? r.blockingTriggerIds : [],
  consentCategory: r.consentCategory,
  fireRule: r.fireRule,
  priority: Number(r.priority ?? 0),
  enabled: Boolean(r.enabled),
  createdAt: tsValue(r.createdAt),
  updatedAt: tsValue(r.updatedAt),
});

/**
 * Validate a tag's kind-specific payload.
 *
 * `allowCustomCode` is passed rather than read here so the same function serves
 * both the write path and the compile path — and the compile path is the one
 * that matters, because it is what makes switching the flag OFF disable tags
 * that already exist.
 */
const parseTagPayload = (
  kind: string,
  templateId: string | null,
  params: unknown,
  allowCustomCode: boolean,
): { templateId: string | null; params: unknown } => {
  if (!(TAG_KINDS as readonly string[]).includes(kind)) {
    throw new AppError("VALIDATION", `Unknown tag kind. Allowed: ${TAG_KINDS.join(", ")}.`);
  }

  if (CUSTOM_CODE_KINDS.includes(kind)) {
    if (!allowCustomCode) {
      throw new AppError(
        "FORBIDDEN",
        "Custom code is turned off for this site. Enable it in the site's settings first.",
      );
    }
    const raw = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const code = str(raw.code, 20_000);
    if (!code) throw new AppError("VALIDATION", "A custom tag needs some code.");
    return { templateId: null, params: { code } };
  }

  if (kind === "image_pixel") {
    const raw = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const url = str(raw.url, 2000) ?? "";
    // https only, and parsed rather than pattern-matched: this URL becomes an
    // `<img src>` on a customer's page, so `javascript:` and `data:` have to be
    // impossible rather than merely unlikely.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError("VALIDATION", "A pixel needs a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new AppError("VALIDATION", "A pixel URL must be https.");
    }
    return { templateId: null, params: { url: parsed.toString() } };
  }

  if (kind === "backlex_event") {
    const raw = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const name = str(raw.name, 120);
    if (!name) throw new AppError("VALIDATION", "An event tag needs an event name.");
    return { templateId: null, params: { name } };
  }

  // kind === "template"
  const id = templateId ?? "";
  if (!getTagTemplate(id)) {
    throw new AppError("VALIDATION", "Unknown tag template.");
  }
  return { templateId: id, params: parseTemplateParams(id, params) };
};

const siteAllowsCustomCode = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
): Promise<boolean> => {
  const t = sitesTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select({ allow: t.allowCustomCode })
    .from(t)
    .where(and(eq(t.id, siteId), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!row) throw new AppError("NOT_FOUND", "Site not found.");
  return Boolean(row.allow);
};

export const listTags = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
): Promise<TagDefinitionRow[]> => {
  const t = tagsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.siteId, siteId), tenantEq(t.tenantId, tenantId)))
    .orderBy(desc(t.priority), t.name)) as any[];
  return rows.map(toTag);
};

export interface TagInput {
  name?: unknown;
  kind?: unknown;
  templateId?: unknown;
  params?: unknown;
  triggerIds?: unknown;
  blockingTriggerIds?: unknown;
  consentCategory?: unknown;
  fireRule?: unknown;
  priority?: unknown;
  enabled?: unknown;
}

const pickEnum = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = typeof v === "string" ? v.trim() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
};

export const createTag = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
  input: TagInput,
  userId: string | null,
  now = Date.now(),
): Promise<TagDefinitionRow> => {
  await assertSiteOwned(ctx, tenantId, siteId);
  const t = tagsTable(ctx.dialect);
  await assertUnder(ctx, t, tenantId, siteId, "tags");

  const kind = str(input.kind, 32) ?? "template";
  const allow = await siteAllowsCustomCode(ctx, tenantId, siteId);
  const { templateId, params } = parseTagPayload(kind, str(input.templateId, 64), input.params, allow);

  const row = {
    id: crypto.randomUUID(),
    tenantId,
    siteId,
    name: str(input.name, 120) ?? "Untitled tag",
    kind,
    templateId,
    params,
    triggerIds: strArray(input.triggerIds, 50),
    blockingTriggerIds: strArray(input.blockingTriggerIds, 50),
    consentCategory: pickEnum<ConsentCategory>(
      input.consentCategory,
      CONSENT_CATEGORIES,
      "marketing",
    ),
    fireRule: pickEnum(input.fireRule, FIRE_RULES, "always"),
    priority: Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : 0,
    enabled: input.enabled !== false,
    createdBy: userId,
    updatedBy: userId,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  await (ctx.db as any).insert(t).values(row);
  return toTag(row);
};

export const updateTag = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  id: string,
  input: TagInput,
  userId: string | null,
  now = Date.now(),
): Promise<TagDefinitionRow> => {
  const t = tagsTable(ctx.dialect);
  const [existing] = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!existing) throw new AppError("NOT_FOUND", "Tag not found.");

  const kind = input.kind !== undefined ? (str(input.kind, 32) ?? "template") : existing.kind;
  const allow = await siteAllowsCustomCode(ctx, tenantId, existing.siteId);
  const { templateId, params } = parseTagPayload(
    kind,
    input.templateId !== undefined ? str(input.templateId, 64) : (existing.templateId ?? null),
    input.params !== undefined ? input.params : existing.params,
    allow,
  );

  const patch: Record<string, unknown> = {
    updatedAt: new Date(now),
    updatedBy: userId,
    kind,
    templateId,
    params,
  };
  if (input.name !== undefined) patch.name = str(input.name, 120) ?? existing.name;
  if (input.triggerIds !== undefined) patch.triggerIds = strArray(input.triggerIds, 50);
  if (input.blockingTriggerIds !== undefined) {
    patch.blockingTriggerIds = strArray(input.blockingTriggerIds, 50);
  }
  if (input.consentCategory !== undefined) {
    patch.consentCategory = pickEnum<ConsentCategory>(
      input.consentCategory,
      CONSENT_CATEGORIES,
      existing.consentCategory,
    );
  }
  if (input.fireRule !== undefined) {
    patch.fireRule = pickEnum(input.fireRule, FIRE_RULES, existing.fireRule);
  }
  if (input.priority !== undefined) {
    patch.priority = Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : 0;
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled !== false;

  await (ctx.db as any)
    .update(t)
    .set(patch)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));
  return toTag({ ...existing, ...patch });
};

export const deleteTag = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  id: string,
): Promise<void> => {
  const t = tagsTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));
};

// ── Compile ───────────────────────────────────────────────────────────────

/**
 * The compiled artifact.
 *
 * `v` is the artifact's own schema version, not the container version. It
 * exists because published artifacts outlive the code that wrote them: a
 * rollback can serve a document compiled by a much older build, and the
 * runtime needs to know what shape it is looking at rather than guessing.
 */
export interface CompiledContainer {
  v: 1;
  site: string;
  variables: { key: string; kind: string; config: unknown }[];
  triggers: { id: string; type: string; config: TriggerConfig; condition: TagConditionNode | null }[];
  tags: {
    id: string;
    name: string;
    kind: string;
    template: string | null;
    params: unknown;
    triggers: string[];
    blocking: string[];
    consent: string;
    fire: string;
    priority: number;
  }[];
}

export interface CompileResult {
  artifact: CompiledContainer;
  /** What was left out, and why. Reported rather than thrown — one broken tag
   *  must not stop an operator publishing the other nine. */
  dropped: { kind: "tag" | "trigger" | "variable"; id: string; name: string; reason: string }[];
}

const reasonOf = (e: unknown): string =>
  e instanceof AppError || e instanceof Error ? e.message : "Invalid configuration.";

export const compileContainer = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
): Promise<CompileResult> => {
  await assertSiteOwned(ctx, tenantId, siteId);
  const allowCustomCode = await siteAllowsCustomCode(ctx, tenantId, siteId);

  const [variables, triggers, tags] = await Promise.all([
    listVariables(ctx, tenantId, siteId),
    listTriggers(ctx, tenantId, siteId),
    listTags(ctx, tenantId, siteId),
  ]);

  const dropped: CompileResult["dropped"] = [];

  const outVars: CompiledContainer["variables"] = [];
  for (const v of variables) {
    try {
      if (v.kind === "js_expression" && !allowCustomCode) {
        // The same gate as a custom tag, deliberately. A variable that
        // evaluates an expression is not a smaller capability than a tag that
        // runs code — it is the same capability wearing a smaller name.
        throw new AppError("FORBIDDEN", "Custom code is turned off for this site.");
      }
      outVars.push({ key: v.key, kind: v.kind, config: parseVariableConfig(v.kind, v.config) });
    } catch (e) {
      dropped.push({ kind: "variable", id: v.id, name: v.key, reason: reasonOf(e) });
    }
  }

  const outTriggers: CompiledContainer["triggers"] = [];
  const liveTriggerIds = new Set<string>();
  for (const tr of triggers) {
    try {
      outTriggers.push({
        id: tr.id,
        type: tr.type,
        config: parseTriggerConfig(tr.type, tr.config),
        condition: tr.condition == null ? null : parseTagCondition(tr.condition),
      });
      liveTriggerIds.add(tr.id);
    } catch (e) {
      dropped.push({ kind: "trigger", id: tr.id, name: tr.name, reason: reasonOf(e) });
    }
  }

  const outTags: CompiledContainer["tags"] = [];
  for (const tag of tags) {
    if (!tag.enabled) continue;
    try {
      const { templateId, params } = parseTagPayload(
        tag.kind,
        tag.templateId,
        tag.params,
        allowCustomCode,
      );
      // A tag pointing only at triggers that failed to compile can never fire.
      // Emitting it would put a dead entry in every visitor's download and make
      // the admin's "published" state a lie.
      const fires = tag.triggerIds.filter((id) => liveTriggerIds.has(id));
      if (fires.length === 0) {
        throw new AppError("VALIDATION", "This tag has no working trigger.");
      }
      outTags.push({
        id: tag.id,
        name: tag.name,
        kind: tag.kind,
        template: templateId,
        params,
        triggers: fires,
        blocking: tag.blockingTriggerIds.filter((id) => liveTriggerIds.has(id)),
        consent: tag.consentCategory,
        fire: tag.fireRule,
        priority: tag.priority,
      });
    } catch (e) {
      dropped.push({ kind: "tag", id: tag.id, name: tag.name, reason: reasonOf(e) });
    }
  }

  // Highest priority first, then by id so the artifact — and therefore its
  // hash — is stable across two compiles of unchanged rows. An unstable hash
  // would make every publish look like a change and defeat the ETag.
  outTags.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  outTriggers.sort((a, b) => a.id.localeCompare(b.id));
  outVars.sort((a, b) => a.key.localeCompare(b.key));

  return { artifact: { v: 1, site: siteId, variables: outVars, triggers: outTriggers, tags: outTags }, dropped };
};

// ── Publish / rollback ────────────────────────────────────────────────────

export interface TagVersionRow {
  id: string;
  siteId: string;
  version: number;
  note: string | null;
  hash: string;
  createdBy: string | null;
  createdAt: number;
}

const toVersion = (r: any): TagVersionRow => ({
  id: r.id,
  siteId: r.siteId,
  version: Number(r.version),
  note: r.note ?? null,
  hash: r.hash,
  createdBy: r.createdBy ?? null,
  createdAt: tsValue(r.createdAt),
});

export const listVersions = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
  limit = 50,
): Promise<TagVersionRow[]> => {
  const t = versionsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      id: t.id,
      siteId: t.siteId,
      version: t.version,
      note: t.note,
      hash: t.hash,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(and(eq(t.siteId, siteId), tenantEq(t.tenantId, tenantId)))
    .orderBy(desc(t.version))
    .limit(Math.min(Math.max(1, limit), 200))) as any[];
  return rows.map(toVersion);
};

export const publishContainer = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
  input: { note?: unknown },
  userId: string | null,
  now = Date.now(),
): Promise<{ version: TagVersionRow; dropped: CompileResult["dropped"] }> => {
  const { artifact, dropped } = await compileContainer(ctx, tenantId, siteId);
  const body = JSON.stringify(artifact);
  // Reuses the shared SHA-256 helper rather than adding a second digest
  // implementation. The name says "token"; it is a plain hex digest, and this
  // value is the ETag the container endpoint serves.
  const hash = await hashToken(body);

  const versions = versionsTable(ctx.dialect);
  const [top] = (await (ctx.db as any)
    .select({ version: versions.version })
    .from(versions)
    .where(and(eq(versions.siteId, siteId), tenantEq(versions.tenantId, tenantId)))
    .orderBy(desc(versions.version))
    .limit(1)) as any[];
  const version = Number(top?.version ?? 0) + 1;

  const row = {
    id: crypto.randomUUID(),
    tenantId,
    siteId,
    version,
    note: str(input.note, 500),
    snapshot: artifact,
    hash,
    createdBy: userId,
    createdAt: new Date(now),
  };
  await (ctx.db as any).insert(versions).values(row);

  const sites = sitesTable(ctx.dialect);
  await (ctx.db as any)
    .update(sites)
    .set({ publishedVersion: version, publishedVersionId: row.id, updatedAt: new Date(now) })
    .where(and(eq(sites.id, siteId), tenantEq(sites.tenantId, tenantId)));

  return { version: toVersion(row), dropped };
};

export const rollbackContainer = async (
  ctx: TagDbCtx,
  tenantId: string | null,
  siteId: string,
  version: number,
  now = Date.now(),
): Promise<TagVersionRow> => {
  const versions = versionsTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.siteId, siteId),
        eq(versions.version, version),
        tenantEq(versions.tenantId, tenantId),
      ),
    )
    .limit(1)) as any[];
  if (!row) throw new AppError("NOT_FOUND", "Version not found.");

  // A pointer move, not a re-compile. What goes live is the document that WAS
  // live, byte for byte — not what today's compiler would make of the rows as
  // they stand now.
  const sites = sitesTable(ctx.dialect);
  await (ctx.db as any)
    .update(sites)
    .set({ publishedVersion: version, publishedVersionId: row.id, updatedAt: new Date(now) })
    .where(and(eq(sites.id, siteId), tenantEq(sites.tenantId, tenantId)));

  return toVersion(row);
};

/**
 * The published artifact for the PUBLIC container route.
 *
 * Not tenant-scoped, and it cannot be: the tag carries a site id and nothing
 * else, exactly like the collect route. What makes that safe is the same thing
 * that makes it safe there — the site id is public by design, this reads a
 * document that is served to anonymous visitors anyway, and it can write
 * nothing. Tenant comes back out so the caller can meter against it.
 */
export const getPublishedArtifact = async (
  ctx: TagDbCtx,
  siteId: string,
): Promise<{ artifact: CompiledContainer; hash: string; version: number; tenantId: string | null } | null> => {
  if (!siteId) return null;
  const sites = sitesTable(ctx.dialect);
  const versions = versionsTable(ctx.dialect);

  const [row] = (await (ctx.db as any)
    .select({
      tenantId: sites.tenantId,
      version: versions.version,
      hash: versions.hash,
      snapshot: versions.snapshot,
    })
    .from(sites)
    .innerJoin(versions, eq(versions.id, sites.publishedVersionId))
    .where(eq(sites.id, siteId))
    .limit(1)) as any[];
  if (!row) return null;

  // pg hands back a parsed object, sqlite hands back the raw TEXT. Both shapes
  // are handled here rather than trusting the driver's json mapper, which
  // throws during row mapping on a malformed blob — before any of this code
  // runs — and would take down the whole route for one bad row.
  let artifact: CompiledContainer;
  try {
    artifact =
      typeof row.snapshot === "string" ? (JSON.parse(row.snapshot) as CompiledContainer) : row.snapshot;
  } catch {
    return null;
  }
  if (!artifact || typeof artifact !== "object") return null;

  return { artifact, hash: String(row.hash), version: Number(row.version), tenantId: row.tenantId ?? null };
};
