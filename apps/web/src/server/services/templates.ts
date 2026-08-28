import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  FIELD_TYPES,
  derivePhysicalTable,
  ftsTableName,
  isPresentational,
  validateFields,
  type FieldDef,
} from "@backlex/db";
import { AppError, OPERATION_BRANCH_KEYS, SYSTEM_ROLES } from "@backlex/core";
import {
  getTemplate,
  type SampleRow,
  type SampleValue,
  type SchemaTemplate,
  type TemplateAgent,
  type TemplateChannel,
  type TemplateCollection,
  type TemplateDashboard,
  type TemplateDocument,
  type TemplateFlag,
  type TemplateFlow,
  type TemplateForm,
  type TemplateKpi,
  type TemplateRole,
} from "../templates/catalog";
import type { Ctx } from "../context";
import { createManagedCollection } from "./collections";
import { invalidateTenantCollections } from "./collections-cache";
import { invalidateTenantPermissions } from "./permissions-cache";
import { createAgent } from "./agents/store";
import { createForm } from "./forms";
import { refreshCollectionRollups, rollupRefreshAllStatements } from "./items/rollup";
import { allocateSequenceValues, sequenceFieldsOf } from "./items/sequence";
import { indexFts, isSearchable } from "./fts";
import {
  deleteVectors,
  embedAndUpsertBatch,
  isVectorizable,
  type VectorizeMeta,
} from "./vectorize";
import { nowFor } from "./items-helpers";
import { serializeField } from "./items/serialize";
import { canonicalizeMoneyFields } from "./items/money-fields";
import { ensureSystemRoles, type DbCtx } from "./seed";
import { PORTAL_LINKS_KEY, mergePortalLink, type PortalLink } from "./portal-links";

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

const settingsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

/** app_settings key holding the seeded-sample manifest: `slug -> [rowId, …]`
 *  for every sample row a template apply inserted. Consumed by
 *  {@link clearTemplateSamples} so "remove sample data" only ever touches rows
 *  the template created — never user data. */
const SEED_MANIFEST_KEY = "templateSampleSeeds";

/** True when the workspace has no managed (non-adopted) collections yet — used
 *  to decide whether to auto-apply the cloud-selected SEED_TEMPLATE. */
export async function hasNoManagedCollections(ctx: DbCtx, tenantId: string): Promise<boolean> {
  const t = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as never as { select: Function })
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.adopted, false)))
    .limit(1);
  return rows.length === 0;
}

export interface ApplyTemplateResult {
  templateId: string;
  created: string[];
  skipped: string[];
  /** Number of sample rows seeded across all newly-created collections. */
  seeded: number;
  /**
   * Sample rows that could not be built, keyed by collection.
   *
   * A sample points at its neighbours by `{ ref: "<slug>:<n>" }`, and a ref
   * resolves only against collections THIS apply seeded. Applying a second
   * template onto a workspace that already owns one of its collection names
   * — `field-service` then `ecommerce`, both of which have `customers` —
   * skips creating that collection, so every sample naming it has nothing to
   * point at. Those rows are skipped and listed here instead of being inserted
   * with a null relation, which used to abort the whole apply on a NOT NULL
   * constraint and leave the workspace half-built.
   */
  samplesSkipped: Record<string, string[]>;
  /** Names of bundled roles created by this apply (existing names skipped). */
  roles: string[];
  /** Names of bundled dashboards created by this apply (existing names skipped). */
  dashboards: string[];
  /** Slugs of bundled KPI definitions created by this apply (existing slugs
   *  skipped, so a re-apply never overwrites one an admin has tuned). */
  kpis: string[];
  /** Names of bundled automation flows created by this apply. */
  flows: string[];
  /** Keys of bundled PDF document templates created by this apply. */
  documents: string[];
  /** Names of bundled public forms created by this apply. The one-time token
   *  is deliberately NOT reported — this result is written verbatim into the
   *  activity log, and a form's link is a credential. Rotate to get one. */
  forms: string[];
  /** Names of bundled AI agents created by this apply. */
  agents: string[];
  /** Keys of bundled feature flags created by this apply. */
  flags: string[];
  /** Patterns of bundled broadcast channels created by this apply. */
  channels: string[];
}

/** Map of `slug -> [insertedId, …]` for already-seeded collections, used to
 *  resolve `{ ref: "slug:index" }` sample references to real ids. */
type SeededIds = Record<string, string[]>;

const isSampleRef = (v: unknown): v is { ref: string } =>
  typeof v === "object" && v !== null && "ref" in v &&
  typeof (v as { ref: unknown }).ref === "string";

/**
 * Resolve a sample's `{ ref: "<slug>:<n>" }` handles against what this apply
 * has seeded so far.
 *
 * `unresolved` collects the refs that pointed at nothing. That happens for one
 * reason in practice: the target collection ALREADY EXISTED in the workspace,
 * so `applyTemplate` skipped creating it and seeded none of its samples — which
 * is what a second template applied onto a first does the moment they share a
 * collection name (`field-service` and `ecommerce` both own `customers`).
 *
 * Before this was collected, an unresolved ref silently became `null`, the
 * INSERT hit the relation's NOT NULL constraint, and the raw driver error
 * escaped as `500 Internal server error` — abandoning the apply partway with
 * 39 of 61 collections created and no way for the caller to know which.
 */
const resolveSample = (
  value: SampleValue,
  seeded: SeededIds,
  unresolved?: string[],
): unknown => {
  if (isSampleRef(value)) {
    const [slug, idx] = value.ref.split(":");
    const hit = seeded[slug ?? ""]?.[Number(idx)] ?? null;
    if (hit === null) unresolved?.push(value.ref);
    return hit;
  }
  if (Array.isArray(value)) return value.map((v) => resolveSample(v, seeded, unresolved));
  return value;
};

const exec = async (ctx: DbCtx, query: unknown): Promise<void> => {
  if (ctx.dialect === "pg") {
    await (ctx.db as never as { execute: Function }).execute(query);
  } else {
    await (ctx.db as never as { run: Function }).run(query);
  }
};

/** Read raw rows from a physical table (sample extraction). */
const queryRows = async (
  ctx: DbCtx,
  query: unknown,
): Promise<Record<string, unknown>[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as never as { execute: Function }).execute(query);
    if (Array.isArray(r)) return r as Record<string, unknown>[];
    if (r && typeof r === "object" && "rows" in (r as object))
      return (r as { rows: Record<string, unknown>[] }).rows;
    return r as Record<string, unknown>[];
  }
  return (await (ctx.db as never as { all: Function }).all(query)) as Record<
    string,
    unknown
  >[];
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Read one tenant-scoped app_settings value (raw, unvalidated). */
const readSetting = async (ctx: DbCtx, tenantId: string, key: string): Promise<unknown> => {
  const st = settingsTable(ctx.dialect);
  const rows = (await (ctx.db as never as { select: Function })
    .select({ value: st.value })
    .from(st)
    .where(and(eq(st.tenantId, tenantId), eq(st.key, key)))
    .limit(1)) as { value: unknown }[];
  return rows[0]?.value;
};

/** Atomic tenant-scoped app_settings upsert — same `onConflictDoUpdate` shape
 *  as `POST /api/collections/layout` (check-then-insert raced under load). */
const writeSetting = async (
  ctx: DbCtx,
  tenantId: string,
  key: string,
  value: unknown,
): Promise<void> => {
  const st = settingsTable(ctx.dialect);
  await (ctx.db as never as { insert: Function })
    .insert(st)
    .values({ id: crypto.randomUUID(), tenantId, key, value })
    .onConflictDoUpdate({
      target: [st.tenantId, st.key],
      set: { value, updatedAt: nowFor(ctx.dialect) },
    });
};

/**
 * Append a template's group headers to the workspace's `collectionGroups`
 * setting. Merge is additive and order-preserving: existing headers keep their
 * saved positions, template headers the workspace doesn't know yet are
 * appended in template order. Never removes or reorders what the admin
 * arranged by hand.
 */
const mergeCollectionGroups = async (
  ctx: DbCtx,
  tenantId: string,
  headers: string[],
): Promise<void> => {
  if (headers.length === 0) return;
  const raw = await readSetting(ctx, tenantId, "collectionGroups");
  const current = isStringArray(raw) ? raw : [];
  const merged = [...current];
  for (const h of headers) if (!merged.includes(h)) merged.push(h);
  if (merged.length === current.length) return;
  await writeSetting(ctx, tenantId, "collectionGroups", merged);
};

/** Merge freshly-seeded sample ids into the seed manifest (additive — a later
 *  apply of a second template extends the same manifest). */
const mergeSeedManifest = async (
  ctx: DbCtx,
  tenantId: string,
  seeds: Record<string, string[]>,
): Promise<void> => {
  if (Object.keys(seeds).length === 0) return;
  const raw = await readSetting(ctx, tenantId, SEED_MANIFEST_KEY);
  const current =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  for (const [slug, ids] of Object.entries(seeds)) {
    const prev = isStringArray(current[slug]) ? (current[slug] as string[]) : [];
    current[slug] = [...prev, ...ids];
  }
  await writeSetting(ctx, tenantId, SEED_MANIFEST_KEY, current);
};

/** Count of seeded sample rows still recorded in the manifest — drives the
 *  "Remove sample data" affordance in the admin UI. */
export async function countSeededSamples(ctx: DbCtx, tenantId: string): Promise<number> {
  const raw = await readSetting(ctx, tenantId, SEED_MANIFEST_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  let n = 0;
  for (const ids of Object.values(raw as Record<string, unknown>)) {
    if (isStringArray(ids)) n += ids.length;
  }
  return n;
}

/**
 * Seed a collection's sample rows. Inserts directly into the physical table
 * (admin-trust, like the flow path in items-helpers) and returns the new ids in
 * sample order so later collections can `ref` them. Versioned collections are
 * seeded as published so demo data is visible without an extra publish step.
 *
 * Full-text search is backfilled inline (best-effort, a handful of rows) so
 * seeded demo data is immediately searchable. Vector embeddings still need a
 * `vectorize` backfill — they require the embedding adapter, which isn't
 * available on this DB-only path.
 */
async function seedSamples(
  ctx: DbCtx,
  tenantId: string,
  col: TemplateCollection,
  seeded: SeededIds,
): Promise<{
  ids: string[];
  rows: Array<{ id: string; row: Record<string, unknown> }>;
  /** Refs that pointed at a collection this apply did not seed. */
  unresolvedRefs: string[];
}> {
  const rows = col.samples ?? [];
  if (rows.length === 0) return { ids: [], rows: [], unresolvedRefs: [] };
  const physicalTable = derivePhysicalTable(tenantId, col.slug);
  const fieldByName = new Map(col.fields.map((f) => [f.name, f]));
  const ids: string[] = [];
  const seededRows: Array<{ id: string; row: Record<string, unknown> }> = [];
  // Document numbers are ALLOCATED for the sample block, never written by the
  // sample. This insert goes straight at the physical table, so a literal
  // `INV-2026-001` in a sample would leave the counter untouched — and the
  // first invoice the workspace actually creates would be issued `INV-0001`
  // against a row that already holds it. One statement per sequence field for
  // the whole block, the same call the batch and CSV-import paths make.
  const seqFields = sequenceFieldsOf(col.fields as FieldDef[]);
  const seqPool = await allocateSequenceValues(
    ctx as unknown as Ctx,
    tenantId,
    col.slug,
    seqFields,
    rows.length,
    new Date(),
  );
  const seqTaken = new Map<string, number>();
  const ftsTarget = { fts: !!col.fts, physicalTable, pkColumn: "id", fields: col.fields };
  const searchable = isSearchable(ftsTarget);
  const unresolvedRefs: string[] = [];

  for (const sample of rows as SampleRow[]) {
    const id = crypto.randomUUID();
    const now = nowFor(ctx.dialect);
    const cols: string[] = ["id", "created_at", "updated_at"];
    const vals: unknown[] = [id, now, now];

    // TemplateCollections are tenant-scoped by default (see createManagedCollection).
    cols.push("tenant_id");
    vals.push(tenantId);
    if (col.ownerScoped) {
      cols.push("owner_id");
      vals.push(null);
    }
    if (col.versioned) {
      cols.push("_status", "_published_at");
      vals.push("published", now);
    }

    const raw: Record<string, unknown> = {};
    /** Refs THIS sample row could not resolve. */
    const rowUnresolved: string[] = [];
    // Money samples are written in major units, like every money value on every
    // other surface — `19.99`, not `1999`. Resolve each one against its field's
    // currency (fixed, or the sibling column in this same sample row) before
    // anything is serialized, so a seeded price is the price the template meant
    // rather than nineteen kuruş. Sample values are already resolved by
    // `resolveSample` below, so this pass runs on a shallow copy of the row
    // whose money keys are literals — which catalog samples always are.
    const moneySample: Record<string, unknown> = { ...(sample as Record<string, unknown>) };
    try {
      canonicalizeMoneyFields(moneySample, col.fields as FieldDef[]);
    } catch (e) {
      throw new AppError(
        "VALIDATION",
        `Template "${col.slug}" sample: ${(e as Error).message}`,
      );
    }
    for (const [key, value] of Object.entries(sample)) {
      const def = fieldByName.get(key);
      // Skipped: unknown/computed fields, `hash` — a sample would land as
      // plaintext where the API stores a scrypt digest — and presentational
      // layout blocks, which own no column at all (custom templates can send
      // anything; catalog templates never sample either).
      //
      // `sequence` and `rollup` join them for the same reason the item write
      // path refuses a value for either: both columns are the server's. A
      // sequence sample would go around the counter (see the allocation
      // above); a rollup sample is a number that contradicts its own children
      // until the refresh pass overwrites it, and silently disagrees with them
      // forever if that pass never runs.
      if (
        !def ||
        def.computed ||
        def.rollup ||
        def.sequence ||
        def.type === "hash" ||
        isPresentational(def)
      )
        continue;
      const resolved =
        def.type === "money" ? moneySample[key] : resolveSample(value, seeded, rowUnresolved);
      raw[def.name] = resolved;
      let serialized = serializeField(resolved, def, ctx.dialect);
      // JSON-ish columns on Postgres: bind a JSON string, never a raw JS
      // array/object — the pg driver turns arrays into pg arrays, which a
      // jsonb column rejects (the documented catalog constraint; custom
      // templates can hit it, so enforce at the engine).
      if (
        ctx.dialect === "pg" &&
        (def.type === "json" || def.type === "relation_many") &&
        serialized !== null &&
        typeof serialized !== "string"
      ) {
        serialized = JSON.stringify(serialized);
      }
      cols.push(def.name);
      vals.push(serialized);
    }

    // The allocated document numbers, one per sequence field, consumed in
    // sample order so the seeded rows read 0001, 0002, … and the counter is
    // left standing after the last of them.
    for (const f of seqFields) {
      const taken = seqTaken.get(f.name) ?? 0;
      const value = seqPool.get(f.name)?.[taken];
      if (value === undefined) continue;
      seqTaken.set(f.name, taken + 1);
      raw[f.name] = value;
      cols.push(f.name);
      vals.push(value);
    }

    // A sample that cannot reach a row it names is not a sample with a hole in
    // it — it is a sample this workspace has no way to build. Skipped and
    // reported, rather than inserted as NULL and left to the constraint.
    if (rowUnresolved.length > 0) {
      unresolvedRefs.push(...rowUnresolved);
      continue;
    }

    const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
    const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
    await exec(
      ctx,
      sql`INSERT INTO ${sql.identifier(physicalTable)} (${colSql}) VALUES (${valSql})`,
    );
    // indexFts is best-effort by contract (logs, never throws) — a search-index
    // hiccup must not abort the apply.
    if (searchable) await indexFts(ctx as unknown as Ctx, ftsTarget, id, raw);
    ids.push(id);
    seededRows.push({ id, row: raw });
  }
  return { ids, rows: seededRows, unresolvedRefs };
}

/** Seed bundled roles + their permission grants. A role whose name already
 *  exists in the workspace is skipped wholesale (grants included) so a
 *  re-apply never duplicates or mutates admin-edited grants. */
async function seedRoles(
  ctx: DbCtx,
  tenantId: string,
  roles: TemplateRole[],
): Promise<string[]> {
  if (roles.length === 0) return [];
  const t =
    ctx.dialect === "pg"
      ? { roles: pg.schema.roles, permissions: pg.schema.permissions }
      : { roles: sqlite.schema.roles, permissions: sqlite.schema.permissions };
  const created: string[] = [];
  for (const role of roles) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.roles.id })
      .from(t.roles)
      .where(and(eq(t.roles.tenantId, tenantId), eq(t.roles.name, role.name)))
      .limit(1);
    if (existing[0]) continue;
    const roleId = crypto.randomUUID();
    await (ctx.db as never as { insert: Function }).insert(t.roles).values({
      id: roleId,
      tenantId,
      name: role.name,
      description: role.description ?? null,
      admin: false,
    });
    for (const p of role.permissions) {
      await (ctx.db as never as { insert: Function }).insert(t.permissions).values({
        id: crypto.randomUUID(),
        roleId,
        collection: p.collection,
        action: p.action,
        fields: p.fields ?? null,
        condition: p.condition ?? null,
      });
    }
    created.push(role.name);
  }
  if (created.length > 0) invalidateTenantPermissions(tenantId);
  return created;
}

/**
 * Seed bundled insights dashboards + panels. A dashboard whose name already
 * exists in the workspace is skipped wholesale, mirroring `seedRoles`.
 *
 * Returns the names it created AND a name→id map covering the skipped ones
 * too. The map is what lets a bundled `report.deliver` flow name a dashboard:
 * the id cannot be known when the catalog is written, and on a re-apply — the
 * case where every dashboard is skipped — an id the seeder never read would
 * leave the flow pointing at nothing.
 */
async function seedDashboards(
  ctx: DbCtx,
  tenantId: string,
  dashboards: TemplateDashboard[],
): Promise<{ created: string[]; ids: Map<string, string> }> {
  const ids = new Map<string, string>();
  if (dashboards.length === 0) return { created: [], ids };
  const t =
    ctx.dialect === "pg"
      ? { dashboards: pg.schema.dashboards, panels: pg.schema.savedPanels }
      : { dashboards: sqlite.schema.dashboards, panels: sqlite.schema.savedPanels };
  const created: string[] = [];
  for (const dash of dashboards) {
    const existing = (await (ctx.db as never as { select: Function })
      .select({ id: t.dashboards.id })
      .from(t.dashboards)
      .where(and(eq(t.dashboards.tenantId, tenantId), eq(t.dashboards.name, dash.name)))
      .limit(1)) as { id: string }[];
    if (existing[0]) {
      ids.set(dash.name, existing[0].id);
      continue;
    }
    const dashboardId = crypto.randomUUID();
    ids.set(dash.name, dashboardId);
    const now = nowFor(ctx.dialect);
    await (ctx.db as never as { insert: Function }).insert(t.dashboards).values({
      id: dashboardId,
      tenantId,
      name: dash.name,
      description: dash.description ?? null,
      layout: null,
      embedEnabled: false,
      embedTokenHash: null,
      embedRoleId: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const [i, panel] of dash.panels.entries()) {
      await (ctx.db as never as { insert: Function }).insert(t.panels).values({
        id: crypto.randomUUID(),
        tenantId,
        name: panel.name,
        description: panel.description ?? null,
        kind: panel.kind,
        sql: null,
        viz: panel.viz,
        config: panel.config,
        // Default: 3 tiles per row on the insights grid (12 cols / w=4).
        layout: panel.layout ?? { x: (i % 3) * 4, y: Math.floor(i / 3) * 4, w: 4, h: 4 },
        dashboardId,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    created.push(dash.name);
  }
  return { created, ids };
}

/**
 * Seed bundled KPI definitions.
 *
 * This is what lets a freshly-applied template answer "how is it going?"
 * rather than only handing over the tools to work it out. The vertical's
 * vocabulary — "net revenue", "refund rate" — arrives already defined, so the
 * KPIs page, a dashboard tile and Ask AI agree on it from the first minute.
 *
 * Skipped per-slug rather than wholesale: a workspace that has re-applied a
 * template, or hand-tuned one definition, keeps its own version while still
 * picking up KPIs added to the template since.
 */
async function seedKpis(
  ctx: DbCtx,
  tenantId: string,
  kpis: TemplateKpi[],
): Promise<string[]> {
  if (kpis.length === 0) return [];
  const t = ctx.dialect === "pg" ? pg.schema.kpis : sqlite.schema.kpis;
  const created: string[] = [];
  for (const kpi of kpis) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, kpi.slug)))
      .limit(1);
    if (existing[0]) continue;
    const now = nowFor(ctx.dialect);
    await (ctx.db as never as { insert: Function }).insert(t).values({
      id: crypto.randomUUID(),
      tenantId,
      slug: kpi.slug,
      name: kpi.name,
      description: kpi.description ?? null,
      collection: kpi.collection,
      agg: kpi.agg,
      field: kpi.field ?? null,
      filter: kpi.filter ?? null,
      dateField: kpi.dateField ?? null,
      groupBy: kpi.groupBy ?? null,
      topN: kpi.topN ?? null,
      format: kpi.format ?? "number",
      unit: kpi.unit ?? null,
      decimals: kpi.decimals ?? null,
      direction: kpi.direction ?? "neutral",
      // A watched figure comes and finds the admins instead of waiting for
      // someone to open the page. Both halves or neither — `validateInput`
      // enforces that on the API and this path inserts directly, so the
      // catalog test enforces it here.
      alertOperator: kpi.alertOperator ?? null,
      alertValue: kpi.alertValue ?? null,
      alertFiring: false,
      pinTo: kpi.pinTo ?? null,
      pinField: kpi.pinField ?? null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
    created.push(kpi.slug);
  }
  return created;
}

/**
 * Prefix a bundled flow uses to name a dashboard THIS template also bundles,
 * in an op field that wants an id (`report.deliver`'s `dashboardId`).
 *
 * A dashboard id does not exist when the catalog is written, and the field is
 * otherwise a run-time template resolved against the triggering row — which
 * knows nothing about the catalog. So the seeder substitutes. The prefix is
 * safe to key off because a real value there is either a UUID or a `{{ }}`
 * expression; neither can begin with this.
 */
const DASHBOARD_REF = "@dashboard:";

/** Rewrite every `@dashboard:<name>` in an operation tree to the seeded id.
 *  Walks nested branches (`then`/`else`/`do`/`onSuccess`/`onError`) so a ref
 *  inside a condition is resolved too. An unresolvable name is left as-is:
 *  the flow then fails visibly at run time rather than silently delivering a
 *  report built from whatever dashboard happened to answer to an empty id. */
const resolveDashboardRefs = (value: unknown, ids: Map<string, string>): unknown => {
  if (typeof value === "string") {
    if (!value.startsWith(DASHBOARD_REF)) return value;
    return ids.get(value.slice(DASHBOARD_REF.length)) ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveDashboardRefs(v, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveDashboardRefs(v, ids),
      ]),
    );
  }
  return value;
};

/**
 * Seed bundled automation flows — the piece that makes a seeded schema *run*.
 *
 * Skipped by name. `flows` carries no unique index on the name (unlike agents,
 * documents, flags and channels, which all do), so the SELECT is the only
 * thing standing between a re-apply and a second copy of every flow.
 */
async function seedFlows(
  ctx: DbCtx,
  tenantId: string,
  flows: TemplateFlow[],
  dashboardIds: Map<string, string>,
): Promise<string[]> {
  if (flows.length === 0) return [];
  const t = ctx.dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;
  const created: string[] = [];
  for (const flow of flows) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.name, flow.name)))
      .limit(1);
    if (existing[0]) continue;
    const now = nowFor(ctx.dialect);
    await (ctx.db as never as { insert: Function }).insert(t).values({
      id: crypto.randomUUID(),
      tenantId,
      name: flow.name,
      trigger: flow.trigger,
      operations: resolveDashboardRefs(flow.operations, dashboardIds),
      layout: null,
      active: flow.active ?? true,
      createdAt: now,
      updatedAt: now,
    });
    created.push(flow.name);
  }
  return created;
}

/** Seed bundled PDF document templates. Skipped per key — `upsertTemplate`
 *  would overwrite a body an admin has since edited, which is the one thing a
 *  re-apply must never do. */
async function seedDocuments(
  ctx: DbCtx,
  tenantId: string,
  documents: TemplateDocument[],
): Promise<string[]> {
  if (documents.length === 0) return [];
  const t = ctx.dialect === "pg" ? pg.schema.documentTemplates : sqlite.schema.documentTemplates;
  const created: string[] = [];
  for (const doc of documents) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.key, doc.key)))
      .limit(1);
    if (existing[0]) continue;
    const now = nowFor(ctx.dialect);
    await (ctx.db as never as { insert: Function }).insert(t).values({
      id: crypto.randomUUID(),
      tenantId,
      key: doc.key,
      name: doc.name,
      description: doc.description ?? null,
      bodyHtml: doc.bodyHtml,
      headerHtml: doc.headerHtml ?? null,
      footerHtml: doc.footerHtml ?? null,
      pageOptions: doc.pageOptions ?? null,
      filename: doc.filename ?? null,
      variables: doc.variables ?? null,
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    created.push(doc.key);
  }
  return created;
}

/**
 * Seed bundled public forms.
 *
 * Goes through `createForm` rather than inserting, on purpose: that is where
 * `assertFieldsEligible` lives, and it checks four things the pure
 * `isFormEligible` predicate cannot (duplicate fields, matrix/scale shape, at
 * least one field, and every schema-`required` field present). A template that
 * drifts from its own collection should fail here, loudly, not ship a form
 * whose every submission 422s.
 *
 * The minted token's plaintext is DISCARDED. Only its hash is stored and there
 * is no reveal path, so the admin presses "Rotate token" to get a link. That
 * is deliberate: this result is written verbatim into the activity log.
 */
async function seedForms(
  ctx: DbCtx,
  tenantId: string,
  forms: TemplateForm[],
): Promise<string[]> {
  if (forms.length === 0) return [];
  const t = ctx.dialect === "pg" ? pg.schema.forms : sqlite.schema.forms;
  const created: string[] = [];
  for (const form of forms) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.name, form.name)))
      .limit(1);
    if (existing[0]) continue;
    await createForm(ctx as unknown as Ctx, {
      name: form.name,
      collection: form.collection,
      fields: form.fields,
      ...(form.settings ? { settings: form.settings } : {}),
      active: form.active ?? true,
      tenantId,
      createdBy: null,
    });
    created.push(form.name);
  }
  return created;
}

/** Seed bundled AI agents. Skipped by name (which carries a unique index).
 *  `createAgent` derives a free `@handle` itself, so two templates whose
 *  agents would collide on one still both land. */
async function seedAgents(
  ctx: DbCtx,
  tenantId: string,
  agents: TemplateAgent[],
): Promise<string[]> {
  if (agents.length === 0) return [];
  const t = ctx.dialect === "pg" ? pg.schema.agents : sqlite.schema.agents;
  const created: string[] = [];
  for (const agent of agents) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.name, agent.name)))
      .limit(1);
    if (existing[0]) continue;
    await createAgent(ctx as unknown as Ctx, tenantId, {
      name: agent.name,
      ...(agent.handle ? { handle: agent.handle } : {}),
      description: agent.description ?? null,
      systemPrompt: agent.systemPrompt,
      ...(agent.model ? { model: agent.model } : {}),
      tools: agent.tools,
      ...(agent.maxSteps !== undefined ? { maxSteps: agent.maxSteps } : {}),
      ...(agent.memory !== undefined ? { memory: agent.memory } : {}),
      active: agent.active ?? true,
      // Never opened to end users by a template. Exposure is a decision an
      // operator makes per agent, and a seeded prompt is not their decision.
      appAccess: false,
    });
    created.push(agent.name);
  }
  return created;
}

/** Seed bundled feature flags. Skipped per key rather than upserted, so a
 *  re-apply keeps a flag an admin has since switched. */
async function seedFlags(
  ctx: DbCtx,
  tenantId: string,
  flags: TemplateFlag[],
): Promise<string[]> {
  if (flags.length === 0) return [];
  const t = ctx.dialect === "pg" ? pg.schema.featureFlags : sqlite.schema.featureFlags;
  const created: string[] = [];
  for (const flag of flags) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.key, flag.key)))
      .limit(1);
    if (existing[0]) continue;
    const now = nowFor(ctx.dialect);
    await (ctx.db as never as { insert: Function }).insert(t).values({
      id: crypto.randomUUID(),
      tenantId,
      key: flag.key,
      enabled: flag.enabled ?? false,
      value: flag.value ?? null,
      rules: flag.rules ?? null,
      description: flag.description ?? null,
      createdAt: now,
      updatedAt: now,
    });
    created.push(flag.key);
  }
  return created;
}

/**
 * Seed bundled broadcast channels. Skipped per pattern (its unique key).
 *
 * `subscribe` / `publish` are TEXT columns holding serialized JSON — not
 * `jsonb`, on either dialect — so they are stringified here. Binding the
 * object would store `[object Object]` on SQLite and be rejected outright by
 * the pg driver.
 */
async function seedChannels(
  ctx: DbCtx,
  tenantId: string,
  channels: TemplateChannel[],
): Promise<string[]> {
  if (channels.length === 0) return [];
  const t =
    ctx.dialect === "pg" ? pg.schema.broadcastChannels : sqlite.schema.broadcastChannels;
  const created: string[] = [];
  for (const ch of channels) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.pattern, ch.pattern)))
      .limit(1);
    if (existing[0]) continue;
    const now = nowFor(ctx.dialect);
    await (ctx.db as never as { insert: Function }).insert(t).values({
      id: crypto.randomUUID(),
      tenantId,
      name: ch.name,
      pattern: ch.pattern,
      subscribe: JSON.stringify(ch.subscribe),
      publish: JSON.stringify(ch.publish),
      presence: ch.presence ?? false,
      replay: ch.replay ?? false,
      retentionHours: ch.retentionHours ?? 24,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    created.push(ch.pattern);
  }
  return created;
}

/**
 * Restate every rollup column the template declares, once the whole template
 * is on disk.
 *
 * A separate pass rather than part of the collection loop, because a rollup
 * names its CHILD collection and the template array is relation-target-first —
 * `invoices` is created before `invoice_lines`, so refreshing inside the loop
 * would look for a table that does not exist yet.
 *
 * `refreshCollectionRollups` rather than a hand-built statement, because the
 * statement it builds carries `childPredicate`: the child's tenant scoping,
 * its soft-delete filter and the rollup's own `filter`. Dropping that would
 * total another workspace's rows into this one's column — a cross-tenant leak
 * wearing a number, which is the hardest kind to notice.
 */
async function refreshTemplateRollups(
  ctx: DbCtx,
  tenantId: string,
  template: SchemaTemplate,
  createdSlugs: Set<string>,
): Promise<void> {
  for (const col of template.collections) {
    if (!createdSlugs.has(col.slug)) continue;
    if (!col.fields.some((f) => (f as FieldDef).rollup)) continue;
    try {
      await refreshCollectionRollups(ctx as unknown as Ctx, tenantId, {
        slug: col.slug,
        physicalTable: derivePhysicalTable(tenantId, col.slug),
        tenantScoped: true,
        softDelete: !!col.softDelete,
        fields: col.fields as FieldDef[],
        pkColumn: "id",
      });
    } catch (e) {
      console.error(
        `[templates] rollup refresh failed for ${col.slug}:`,
        (e as Error).message,
      );
    }
  }
}

/**
 * Materialize a template definition into a workspace. Ensures system roles
 * exist, then creates each collection in dependency order (relation targets
 * first) with its admin group + position, merges the template's group headers
 * into the workspace's `collectionGroups`, seeds sample data (recorded in the
 * seed manifest for later cleanup), and seeds any bundled roles/dashboards.
 *
 * Idempotent — collections/roles/dashboards that already exist are skipped, so
 * a re-apply or a partially-seeded workspace converges cleanly, and layout
 * changes the admin made after a previous apply are never overwritten.
 */
export async function applyTemplateDefinition(
  ctx: DbCtx,
  tenantId: string,
  template: SchemaTemplate,
): Promise<ApplyTemplateResult> {
  await ensureSystemRoles(ctx, tenantId);

  // Header order: the template's explicit `groups` list, then any group used
  // by a collection but missing from that list (first-appearance order).
  const usedOrder: string[] = [];
  for (const col of template.collections) {
    if (col.group && !usedOrder.includes(col.group)) usedOrder.push(col.group);
  }
  const headers = [...(template.groups ?? [])];
  for (const g of usedOrder) if (!headers.includes(g)) headers.push(g);

  const created: string[] = [];
  const skipped: string[] = [];
  const seededIds: SeededIds = {};
  const manifest: Record<string, string[]> = {};
  const perGroupCount = new Map<string, number>();
  let seeded = 0;
  const samplesSkipped: Record<string, string[]> = {};
  try {
    for (const col of template.collections) {
      // Position within the group: an explicit `sortOrder` wins (extracted
      // templates — their array is dependency-ordered, not display-ordered);
      // otherwise it follows template order (10, 20, …), counted over ALL
      // template collections so skips don't shift later positions.
      let sortOrder: number | null = col.sortOrder ?? null;
      if (col.group && sortOrder === null) {
        const next = (perGroupCount.get(col.group) ?? 0) + 1;
        perGroupCount.set(col.group, next);
        sortOrder = next * 10;
      }
      const res = await createManagedCollection(ctx, tenantId, {
        ...col,
        group: col.group ?? null,
        sortOrder,
      });
      (res.created ? created : skipped).push(res.slug);
      // Only seed freshly-created collections — re-applying over an existing
      // workspace must never duplicate sample rows.
      if (res.created && col.samples?.length) {
        const out = await seedSamples(ctx, tenantId, col, seededIds);
        seededIds[col.slug] = out.ids;
        manifest[col.slug] = out.ids;
        seeded += out.ids.length;
        if (out.unresolvedRefs.length > 0) samplesSkipped[col.slug] = out.unresolvedRefs;
        // Vector backfill for the seeded rows — only when the caller handed us
        // a full Ctx (REST/GraphQL apply). The SEED_TEMPLATE auto-apply during
        // context assembly passes a bare DbCtx and skips it (rows remain
        // backfillable later via POST /collections/:slug/vectorize). Mirrors
        // the inline FTS backfill: best-effort, never aborts the apply.
        const rich = ctx as DbCtx & Partial<Pick<Ctx, "embedding" | "vector" | "env">>;
        if (rich.embedding && rich.vector && rich.env && out.rows.length) {
          const meta: VectorizeMeta = {
            slug: col.slug,
            vectorize: !!col.vectorize,
            vectorizeModel: col.vectorizeModel ?? null,
            fields: col.fields,
          };
          if (isVectorizable(meta, rich.env)) {
            try {
              await embedAndUpsertBatch(rich as Ctx, meta, tenantId, out.rows);
            } catch (e) {
              console.error(
                `[templates] vector backfill failed for ${col.slug}:`,
                (e as Error).message,
              );
            }
          }
        }
      }
    }
  } finally {
    // Record whatever WAS seeded even when a later collection fails — a
    // half-applied workspace must still be cleanable via clear-samples.
    try {
      await mergeSeedManifest(ctx, tenantId, manifest);
    } catch (e) {
      console.error("[templates] seed-manifest write failed:", (e as Error).message);
    }
    invalidateTenantCollections(tenantId);
  }

  // Only merge headers that actually gained a collection this apply — a full
  // re-apply (everything skipped) must not resurrect group headers the admin
  // deleted since.
  const createdGroups = new Set(
    template.collections.filter((c) => c.group && created.includes(c.slug)).map((c) => c.group as string),
  );
  await mergeCollectionGroups(ctx, tenantId, headers.filter((h) => createdGroups.has(h)));

  // Every rollup column the template declares, restated from the rows that
  // were just seeded. After the whole loop — see the function's own note.
  await refreshTemplateRollups(ctx, tenantId, template, new Set(created));

  const roles = await seedRoles(ctx, tenantId, template.roles ?? []);
  const dashboards = await seedDashboards(ctx, tenantId, template.dashboards ?? []);
  const kpis = await seedKpis(ctx, tenantId, template.kpis ?? []);

  // The rest of the bundle — what turns the schema into something that runs.
  // Each is best-effort for the same reason the portal-link merge is: an apply
  // that already created collections must not be reported as a failure
  // because one flow named a collection somebody renamed. The catalog test is
  // what keeps the built-in templates from ever reaching this branch.
  const bundle = { flows: [] as string[], documents: [] as string[], forms: [] as string[], agents: [] as string[], flags: [] as string[], channels: [] as string[] };
  const seedBundle = async (
    what: keyof typeof bundle,
    run: () => Promise<string[]>,
  ): Promise<void> => {
    try {
      bundle[what] = await run();
    } catch (e) {
      console.error(`[templates] ${what} seeding failed:`, (e as Error).message);
    }
  };
  await seedBundle("flows", () =>
    seedFlows(ctx, tenantId, template.flows ?? [], dashboards.ids),
  );
  await seedBundle("documents", () => seedDocuments(ctx, tenantId, template.documents ?? []));
  await seedBundle("forms", () => seedForms(ctx, tenantId, template.forms ?? []));
  await seedBundle("agents", () => seedAgents(ctx, tenantId, template.agents ?? []));
  await seedBundle("flags", () => seedFlags(ctx, tenantId, template.flags ?? []));
  await seedBundle("channels", () => seedChannels(ctx, tenantId, template.channels ?? []));

  // Portal auto-link rules bundled with person collections. Merge is
  // idempotent per collection (an existing — possibly admin-edited — rule is
  // never overwritten) and best-effort: a settings hiccup must not fail an
  // apply that already created collections.
  for (const col of template.collections) {
    if (!col.portalLink) continue;
    try {
      await mergePortalLink(ctx, tenantId, {
        collection: col.slug,
        emailField: col.portalLink.emailField,
        userField: "app_user_id",
        role: col.portalLink.role,
      });
    } catch (e) {
      console.error(
        `[templates] portal-link merge failed for ${col.slug}:`,
        (e as Error).message,
      );
    }
  }

  // Same-isolate freshness for every apply path (REST, GraphQL, MCP via REST,
  // and the SEED_TEMPLATE auto-apply in context.ts which previously relied on
  // cold caches). Cross-isolate convergence stays on the cache TTL.
  invalidateTenantCollections(tenantId);
  return {
    templateId: template.id,
    created,
    skipped,
    seeded,
    samplesSkipped,
    roles,
    dashboards: dashboards.created,
    kpis,
    ...bundle,
  };
}

/** Seed a catalog template by id — thin wrapper over
 *  {@link applyTemplateDefinition}. */
export async function applyTemplate(
  ctx: DbCtx,
  tenantId: string,
  templateId: string,
): Promise<ApplyTemplateResult> {
  const template = getTemplate(templateId);
  if (!template) throw new AppError("VALIDATION", `Unknown template "${templateId}"`);
  return applyTemplateDefinition(ctx, tenantId, template);
}

export interface ClearSamplesResult {
  /** Sample rows actually deleted (rows the admin already deleted are not counted). */
  removed: number;
  /** Collections that still existed and had seeded rows removed. */
  collections: string[];
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * Delete every sample row recorded in the seed manifest, then drop those ids
 * from the manifest. Only touches ids the template apply inserted — rows the
 * admin created (or seeded rows they already deleted) are untouched, so this
 * is the safe "remove sample data" escape hatch after exploring a template.
 *
 * Bulk admin op by design: deletes rows as a set (FTS shadow rows + vector
 * embeddings cleaned up alongside) without running the per-item delete
 * pipeline — no webhooks/flows/realtime events, no app-layer ON DELETE
 * fixups (intra-template refs are deleted together anyway).
 *
 * Takes the full {@link Ctx} (not just DbCtx) because vector cleanup needs
 * the embedding adapter + env.
 */
export async function clearTemplateSamples(
  ctx: Ctx,
  tenantId: string,
): Promise<ClearSamplesResult> {
  const raw = await readSetting(ctx, tenantId, SEED_MANIFEST_KEY);
  const manifest =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const slugs = Object.keys(manifest).filter((s) => isStringArray(manifest[s]));
  if (slugs.length === 0) return { removed: 0, collections: [] };

  const t = collectionsTable(ctx.dialect);
  const rows = (await (ctx.db as never as { select: Function })
    .select({
      slug: t.slug,
      physicalTable: t.physicalTable,
      fields: t.fields,
      fts: t.fts,
      vectorize: t.vectorize,
      vectorizeModel: t.vectorizeModel,
    })
    .from(t)
    .where(eq(t.tenantId, tenantId))) as {
    slug: string;
    physicalTable: string;
    fields: FieldDef[];
    fts: boolean | number;
    vectorize: boolean | number;
    vectorizeModel: string | null;
  }[];
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  let removed = 0;
  const touched: string[] = [];
  // Every manifest id we handled this run (deleted, already-gone, or its
  // collection deleted) — subtracted from a FRESH manifest read at the end so
  // ids merged by an apply that finishes mid-clear are never dropped.
  const processed = new Map<string, Set<string>>();
  for (const slug of slugs) {
    const ids = manifest[slug] as string[];
    processed.set(slug, new Set(ids));
    const col = bySlug.get(slug);
    // Collection deleted since the seed → its rows went with the table.
    if (!col) continue;
    let removedHere = 0;
    for (const batch of chunk(ids, 50)) {
      const inList = sql.join(batch.map((id) => sql`${id}`), sql`, `);
      const existing = await queryIds(
        ctx,
        sql`SELECT ${sql.identifier("id")} AS id FROM ${sql.identifier(col.physicalTable)} WHERE ${sql.identifier("id")} IN (${inList})`,
      );
      if (existing.length === 0) continue;
      const delList = sql.join(existing.map((id) => sql`${id}`), sql`, `);
      await exec(
        ctx,
        sql`DELETE FROM ${sql.identifier(col.physicalTable)} WHERE ${sql.identifier("id")} IN (${delList})`,
      );
      // SQLite keeps the FTS index in a shadow table — drop those rows too
      // (best-effort; Postgres keeps `_fts` inline, gone with the row).
      if (ctx.dialect === "sqlite" && col.fts) {
        try {
          await exec(
            ctx,
            sql`DELETE FROM ${sql.identifier(ftsTableName(col.physicalTable))} WHERE ${sql.identifier("item_id")} IN (${delList})`,
          );
        } catch (e) {
          console.error(`[templates] fts cleanup failed for ${slug}:`, (e as Error).message);
        }
      }
      // Embeddings from a post-seed `vectorize` backfill would otherwise stay
      // orphaned in the vector index and keep matching semantic search.
      // deleteVectors is best-effort by contract (logs, never throws).
      if (col.vectorize) {
        await deleteVectors(
          ctx,
          {
            slug,
            vectorize: true,
            vectorizeModel: col.vectorizeModel ?? null,
            fields: col.fields ?? [],
          },
          tenantId,
          existing,
        );
      }
      removedHere += existing.length;
    }
    if (removedHere > 0) touched.push(slug);
    removed += removedHere;
  }

  // Restate any parent total the deleted children fed. This path deletes rows
  // as a set, so there is no per-row write for the usual targeted refresh to
  // hang off — `rollupRefreshAllStatements` is the blunt instrument built for
  // exactly that (the app-layer ON DELETE triggers use it too). Without it,
  // "Remove sample data" leaves every seeded invoice still showing the total
  // of line items that are gone.
  for (const slug of touched) {
    try {
      for (const stmt of await rollupRefreshAllStatements(ctx, tenantId, slug)) {
        await exec(ctx, stmt);
      }
    } catch (e) {
      console.error(`[templates] rollup refresh after clear failed for ${slug}:`, (e as Error).message);
    }
  }

  // Re-read and subtract only what we processed (instead of writing `{}`):
  // an apply racing this clear keeps its freshly-merged ids clearable.
  const freshRaw = await readSetting(ctx, tenantId, SEED_MANIFEST_KEY);
  const fresh =
    freshRaw && typeof freshRaw === "object" && !Array.isArray(freshRaw)
      ? (freshRaw as Record<string, unknown>)
      : {};
  const next: Record<string, string[]> = {};
  for (const [slug, ids] of Object.entries(fresh)) {
    if (!isStringArray(ids)) continue;
    const done = processed.get(slug);
    const remaining = done ? ids.filter((id) => !done.has(id)) : ids;
    if (remaining.length > 0) next[slug] = remaining;
  }
  await writeSetting(ctx, tenantId, SEED_MANIFEST_KEY, next);
  return { removed, collections: touched };
}

const queryIds = async (ctx: DbCtx, query: unknown): Promise<string[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as never as { execute: Function }).execute(query);
    const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? []);
    return (rows as { id: unknown }[]).map((x) => String(x.id));
  }
  const rows = (await (ctx.db as never as { all: Function }).all(query)) as { id: unknown }[];
  return rows.map((x) => String(x.id));
};

/** A workspace schema exported in template format — apply it elsewhere via
 *  `POST /api/admin/templates/apply` with `{ template }`. */
/**
 * One thing the export could not carry, said out loud.
 *
 * Borrowed from `rls.plan`'s omissions list, whose own file says it "is not a
 * footnote": an export that silently drops half of what it found is worse than
 * one that refuses, because the loss only surfaces in the target workspace,
 * later, as a feature that quietly does nothing. Every secret, every piece of
 * runtime state and every reference that cannot survive the trip is named here
 * instead of vanishing.
 */
export interface TemplateOmission {
  /** `form:Contact us`, `dashboard:Revenue` — kind and natural key. */
  resource: string;
  /** The field or part that was left out. */
  what: string;
  /** Why it could not travel, and what the target has to do about it. */
  reason: string;
}

export interface ExtractedTemplate {
  label: string;
  description: string;
  groups: string[];
  collections: TemplateCollection[];
  roles?: TemplateRole[];
  dashboards?: TemplateDashboard[];
  kpis?: TemplateKpi[];
  flows?: TemplateFlow[];
  documents?: TemplateDocument[];
  forms?: TemplateForm[];
  agents?: TemplateAgent[];
  flags?: TemplateFlag[];
  channels?: TemplateChannel[];
  /** Present whenever anything was left behind. Empty is omitted entirely, so
   *  a clean export stays a clean document. */
  omissions?: TemplateOmission[];
}

interface ExtractRow {
  slug: string;
  singular: string | null;
  plural: string | null;
  note: string | null;
  displayTemplate: string | null;
  icon: string | null;
  color: string | null;
  hidden: boolean | number;
  previewUrl: string | null;
  ownerScoped: boolean | number;
  versioned: boolean | number;
  vectorize: boolean | number;
  vectorizeModel: string | null;
  fts: boolean | number;
  defaultSort: string | null;
  group: string | null;
  sortOrder: number | null;
  singleton: boolean | number;
  softDelete: boolean | number;
  auditReads: boolean | number;
  kanbanGroupBy: string | null;
  kanbanActionMap: Record<string, string> | null;
  stagedEdits: boolean | number;
  fields: FieldDef[];
}

/** Relation targets a collection's fields point at (self-references excluded —
 *  a table can reference itself during its own create). */
const relationDeps = (row: ExtractRow): string[] => {
  const deps = new Set<string>();
  for (const f of row.fields ?? []) {
    if ((f.type === "relation" || f.type === "relation_many") && f.to && f.to !== row.slug) {
      deps.add(f.to);
    }
  }
  return [...deps];
};

/**
 * The bundle half of {@link extractTemplate}.
 *
 * `apply` could seed nine kinds of thing beyond collections; `extract` emitted
 * none of them, so a workspace that exported its own setup and applied it
 * somewhere else got the tables and nothing that made them work — no roles, no
 * automation, no forms, no boards. This closes that, and the shape of the job
 * is the same four questions for every resource:
 *
 *  1. **Natural key** — what identifies this row somewhere else. Every kind
 *     here already has one that `apply`'s seeder skips on, so nothing is
 *     invented: role/flow/form/agent/dashboard by `name`, KPI by `slug`,
 *     document/flag by `key`, channel by `pattern`.
 *  2. **Portable config** — what actually travels.
 *  3. **Secrets** — never exported, in any form. A hashed token cannot be
 *     exported usefully AND must not be promoted (two workspaces answering one
 *     URL token), so it is dropped and NAMED.
 *  4. **Runtime state** — never promoted. A KPI's `alertFiring` would import
 *     another workspace's alarm as already ringing; a form's submission count
 *     would import somebody else's traffic.
 *
 * Anything that fails 3 or 4, and every reference that cannot survive the trip,
 * lands in {@link TemplateOmission} rather than disappearing.
 */
const extractBundles = async (
  ctx: DbCtx,
  tenantId: string,
  slugs: Set<string>,
  omit: (o: TemplateOmission) => void,
): Promise<Omit<ExtractedTemplate, "label" | "description" | "groups" | "collections" | "omissions">> => {
  const s = ctx.dialect === "pg" ? pg.schema : sqlite.schema;
  const db = ctx.db as never as { select: Function };
  // The pg and sqlite schemas are structurally distinct types with the same
  // shape, so a generic over both does not narrow — the same reason this file
  // already casts `ctx.db`. Through `unknown`, per the compiler's own advice.
  const mine = (t: unknown) => eq((t as unknown as { tenantId: never }).tenantId, tenantId as never);
  const bool = (v: unknown): boolean => v === true || v === 1;
  const json = <T>(v: unknown, fallback: T): T => {
    if (v == null) return fallback;
    if (typeof v !== "string") return v as T;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  };
  /** A collection this export does not carry — a reference into it would land
   *  in a workspace where the slug may mean something else, or nothing. */
  const outside = (slug: string) => !slugs.has(slug);

  // ---- roles + permissions ------------------------------------------------
  // The system roles are excluded: `ensureSystemRoles` creates admin /
  // authenticated / public in every workspace before a template is applied, so
  // exporting them would emit three rows the seeder is guaranteed to skip.
  const roleRows = (await db
    .select({ id: s.roles.id, name: s.roles.name, description: s.roles.description })
    .from(s.roles)
    .where(mine(s.roles))) as { id: string; name: string; description: string | null }[];
  const custom = roleRows.filter(
    (r) => r.name !== SYSTEM_ROLES.admin && r.name !== SYSTEM_ROLES.authenticated && r.name !== SYSTEM_ROLES.public,
  );
  const roleNameById = new Map(roleRows.map((r) => [r.id, r.name]));
  // `permissions` carries no tenant_id — it is scoped only transitively through
  // `role_id`. Constraining the QUERY to this workspace's own role ids rather
  // than reading every row and filtering afterwards: the filter would be
  // correct, but "select everything, discard what is not ours" is the shape a
  // later refactor turns into a leak, and on a shared deployment it reads every
  // workspace's grants to answer a question about one.
  const perms = custom.length
    ? ((await db
        .select({
          roleId: s.permissions.roleId,
          collection: s.permissions.collection,
          action: s.permissions.action,
          fields: s.permissions.fields,
          condition: s.permissions.condition,
        })
        .from(s.permissions)
        .where(inArray(s.permissions.roleId, custom.map((r) => r.id)))) as {
        roleId: string;
        collection: string;
        action: string;
        fields: unknown;
        condition: unknown;
      }[])
    : [];
  const roles: TemplateRole[] = custom.map((r) => {
    const grants = perms.filter((p) => p.roleId === r.id);
    const kept = grants.filter((p) => {
      // A grant naming a collection this export leaves behind would apply into
      // a workspace where that slug is absent — or, worse, is somebody else's
      // collection with the same name.
      if (outside(p.collection)) {
        omit({
          resource: `role:${r.name}`,
          what: `permission on "${p.collection}"`,
          reason: "that collection is not part of this export; grant it by hand in the target",
        });
        return false;
      }
      return true;
    });
    return {
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      permissions: kept.map((p) => ({
        collection: p.collection,
        action: p.action as TemplateRole["permissions"][number]["action"],
        ...(Array.isArray(json(p.fields, null)) ? { fields: json<string[]>(p.fields, []) } : {}),
        ...(json(p.condition, null) != null ? { condition: json<unknown>(p.condition, null) } : {}),
      })),
    };
  });

  // ---- dashboards + panels ------------------------------------------------
  const dashRows = (await db
    .select({
      id: s.dashboards.id,
      name: s.dashboards.name,
      description: s.dashboards.description,
      embedEnabled: s.dashboards.embedEnabled,
      embedRoleId: s.dashboards.embedRoleId,
    })
    .from(s.dashboards)
    .where(mine(s.dashboards))) as {
    id: string;
    name: string;
    description: string | null;
    embedEnabled: unknown;
    embedRoleId: string | null;
  }[];
  const panelRows = dashRows.length
    ? ((await db
        .select({
          name: s.savedPanels.name,
          description: s.savedPanels.description,
          kind: s.savedPanels.kind,
          viz: s.savedPanels.viz,
          config: s.savedPanels.config,
          layout: s.savedPanels.layout,
          dashboardId: s.savedPanels.dashboardId,
        })
        .from(s.savedPanels)
        .where(mine(s.savedPanels))) as {
        name: string;
        description: string | null;
        kind: string;
        viz: string;
        config: unknown;
        layout: unknown;
        dashboardId: string | null;
      }[])
    : [];
  const dashboards: TemplateDashboard[] = dashRows.map((d) => {
    if (bool(d.embedEnabled)) {
      // The embed token is a hash of a credential shown once; there is nothing
      // to export and promoting it would point two workspaces' public embeds at
      // one token.
      omit({
        resource: `dashboard:${d.name}`,
        what: "public embed (token, enabled flag, viewer role)",
        reason: "the embed token is a one-way hash — re-enable the embed in the target to mint a new one",
      });
    }
    if (d.embedRoleId && roleNameById.has(d.embedRoleId)) {
      // Recorded separately: even with a fresh token, the viewer role is a raw
      // id here and the template format has no slot to name it.
      omit({
        resource: `dashboard:${d.name}`,
        what: `embed viewer role "${roleNameById.get(d.embedRoleId)}"`,
        reason: "the template format carries no embed settings; set it again after re-enabling the embed",
      });
    }
    const panels = panelRows.filter((p) => p.dashboardId === d.id);
    const usable = panels.filter((p) => {
      if (p.kind !== "items-aggregate" && p.kind !== "static") {
        // Raw-SQL panels are refused on the apply side for every runtime, so
        // emitting one would produce a template that cannot be applied.
        omit({
          resource: `dashboard:${d.name}`,
          what: `panel "${p.name}" (kind ${p.kind})`,
          reason: "only items-aggregate and static panels are portable — a raw SQL panel is bound to this database",
        });
        return false;
      }
      return true;
    });
    return {
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      panels: usable.map((p) => ({
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
        kind: p.kind as TemplateDashboard["panels"][number]["kind"],
        viz: p.viz as TemplateDashboard["panels"][number]["viz"],
        config: json<Record<string, unknown>>(p.config, {}),
        ...(json(p.layout, null) ? { layout: json<{ x: number; y: number; w: number; h: number }>(p.layout, { x: 0, y: 0, w: 4, h: 2 }) } : {}),
      })),
    };
  });

  // ---- KPIs ----------------------------------------------------------------
  const kpiRows = (await db
    .select({
      slug: s.kpis.slug,
      name: s.kpis.name,
      description: s.kpis.description,
      collection: s.kpis.collection,
      agg: s.kpis.agg,
      field: s.kpis.field,
      filter: s.kpis.filter,
      dateField: s.kpis.dateField,
      groupBy: s.kpis.groupBy,
      topN: s.kpis.topN,
      format: s.kpis.format,
      unit: s.kpis.unit,
      decimals: s.kpis.decimals,
      direction: s.kpis.direction,
      alertOperator: s.kpis.alertOperator,
      alertValue: s.kpis.alertValue,
      pinTo: s.kpis.pinTo,
      pinField: s.kpis.pinField,
    })
    .from(s.kpis)
    .where(mine(s.kpis))) as Record<string, never>[];
  const kpis: TemplateKpi[] = [];
  for (const k of kpiRows as unknown as (TemplateKpi & { collection: string; pinTo?: string | null })[]) {
    if (outside(k.collection)) {
      omit({
        resource: `kpi:${k.slug}`,
        what: "the whole KPI",
        reason: `it aggregates "${k.collection}", which is not part of this export`,
      });
      continue;
    }
    const { pinTo, ...rest } = k;
    const pinnable = pinTo && !outside(pinTo);
    if (pinTo && !pinnable) {
      omit({
        resource: `kpi:${k.slug}`,
        what: `pin to "${pinTo}"`,
        reason: "the pinned collection is not part of this export; the figure still works, it just is not pinned",
      });
    }
    kpis.push(
      compact({
        ...rest,
        ...(pinnable ? { pinTo } : { pinTo: undefined, pinField: undefined }),
      }) as TemplateKpi,
    );
  }

  // ---- flows ---------------------------------------------------------------
  const flowRows = (await db
    .select({
      name: s.flows.name,
      trigger: s.flows.trigger,
      operations: s.flows.operations,
      active: s.flows.active,
    })
    .from(s.flows)
    .where(mine(s.flows))) as {
    name: string;
    trigger: string;
    operations: unknown;
    active: unknown;
  }[];
  const dashboardNameById = new Map(dashRows.map((d) => [d.id, d.name]));
  const flows: TemplateFlow[] = flowRows.map((f) => {
    // Cloned before the walk below mutates it: on a json-mode column the driver
    // hands back a live object, and rewriting a dashboard id or stripping a
    // header in place would edit whatever else holds that reference.
    const ops = JSON.parse(JSON.stringify(json<unknown[]>(f.operations, []))) as unknown[];
    // A `report.deliver` step holds a concrete dashboard UUID, which means
    // nothing anywhere else. `apply` already understands `@dashboard:<name>`
    // and resolves it after seeding, so the export inverts that mapping —
    // otherwise the seeded flow would deliver a dashboard that does not exist.
    walkTemplateOps(ops, (op) => {
      // A step's request headers are the one place a SECRET hides inside
      // otherwise-portable config: `headers` is a free-form Record<string,string>
      // on `webhook` / `request`, and an author putting `Authorization: Bearer …`
      // there is the normal way to call an authenticated API. The columns this
      // export reads are all secret-free; without this, the op tree would carry
      // one out anyway.
      if (op.headers && typeof op.headers === "object") {
        const names = Object.keys(op.headers as Record<string, unknown>);
        delete op.headers;
        if (names.length) {
          omit({
            resource: `flow:${f.name}`,
            what: `request headers on a ${String(op.type)} step (${names.join(", ")})`,
            reason: "a header can carry a credential, so headers are never exported — set them again in the target",
          });
        }
      }
      if (op.type !== "report.deliver") return;
      const id = (op as { dashboardId?: unknown }).dashboardId;
      if (typeof id !== "string" || id.startsWith("@dashboard:")) return;
      const named = dashboardNameById.get(id);
      if (named) (op as { dashboardId?: unknown }).dashboardId = `@dashboard:${named}`;
      else
        omit({
          resource: `flow:${f.name}`,
          what: "the dashboard a report.deliver step delivers",
          reason: "it names a dashboard this export does not carry; point the step at one in the target",
        });
    });
    return {
      name: f.name,
      trigger: f.trigger,
      operations: ops as TemplateFlow["operations"],
      ...(bool(f.active) ? {} : { active: false }),
    };
  });

  // ---- document templates --------------------------------------------------
  const documents = ((await db
    .select({
      key: s.documentTemplates.key,
      name: s.documentTemplates.name,
      description: s.documentTemplates.description,
      bodyHtml: s.documentTemplates.bodyHtml,
      headerHtml: s.documentTemplates.headerHtml,
      footerHtml: s.documentTemplates.footerHtml,
      pageOptions: s.documentTemplates.pageOptions,
      filename: s.documentTemplates.filename,
      variables: s.documentTemplates.variables,
    })
    .from(s.documentTemplates)
    .where(mine(s.documentTemplates))) as Record<string, unknown>[]).map(
    (d) => compact({ ...d, pageOptions: json(d.pageOptions, undefined), variables: json(d.variables, undefined) }) as TemplateDocument,
  );

  // ---- forms ---------------------------------------------------------------
  const formRows = (await db
    .select({
      name: s.forms.name,
      collection: s.forms.collection,
      fields: s.forms.fields,
      settings: s.forms.settings,
      active: s.forms.active,
    })
    .from(s.forms)
    .where(mine(s.forms))) as {
    name: string;
    collection: string;
    fields: unknown;
    settings: unknown;
    active: unknown;
  }[];
  const forms: TemplateForm[] = [];
  for (const f of formRows) {
    if (outside(f.collection)) {
      omit({
        resource: `form:${f.name}`,
        what: "the whole form",
        reason: `it writes into "${f.collection}", which is not part of this export`,
      });
      continue;
    }
    // Every export of a form loses its public link, and that is not a bug to
    // work around: the token is stored as a one-way hash, so there is nothing
    // to carry, and carrying it would make two workspaces' forms answer to one
    // URL. The target rotates the token to get a shareable link.
    omit({
      resource: `form:${f.name}`,
      what: "the public link token",
      reason: "stored as a one-way hash — press Rotate token in the target to mint a shareable URL",
    });
    forms.push({
      name: f.name,
      collection: f.collection,
      fields: json<TemplateForm["fields"]>(f.fields, []),
      ...(json(f.settings, null) ? { settings: json<Record<string, unknown>>(f.settings, {}) } : {}),
      ...(bool(f.active) ? {} : { active: false }),
    });
  }

  // ---- agents --------------------------------------------------------------
  const agentRows = (await db
    .select({
      name: s.agents.name,
      handle: s.agents.handle,
      description: s.agents.description,
      systemPrompt: s.agents.systemPrompt,
      model: s.agents.model,
      tools: s.agents.tools,
      maxSteps: s.agents.maxSteps,
      memory: s.agents.memory,
      active: s.agents.active,
      appAccess: s.agents.appAccess,
    })
    .from(s.agents)
    .where(mine(s.agents))) as Record<string, unknown>[];
  const agents: TemplateAgent[] = agentRows.map((a) => {
    if (bool(a.appAccess)) {
      // Exposure to end users is the one setting whose blast radius leaves the
      // workspace, so it is re-decided in the target rather than inherited —
      // the seeder forces it false for the same reason.
      omit({
        resource: `agent:${a.name as string}`,
        what: "open to end users",
        reason: "exposure is re-decided per workspace; the agent arrives closed and an admin opens it",
      });
    }
    return compact({
      name: a.name,
      handle: a.handle,
      description: a.description,
      systemPrompt: a.systemPrompt ?? "",
      tools: json<string[]>(a.tools, []),
      model: a.model,
      maxSteps: a.maxSteps,
      memory: bool(a.memory) ? true : undefined,
      active: bool(a.active) ? undefined : false,
    }) as TemplateAgent;
  });

  // ---- feature flags -------------------------------------------------------
  const flags = ((await db
    .select({
      key: s.featureFlags.key,
      enabled: s.featureFlags.enabled,
      value: s.featureFlags.value,
      rules: s.featureFlags.rules,
      description: s.featureFlags.description,
    })
    .from(s.featureFlags)
    .where(mine(s.featureFlags))) as Record<string, unknown>[]).map(
    (f) =>
      compact({
        key: f.key,
        enabled: bool(f.enabled) ? true : undefined,
        value: json(f.value, undefined),
        rules: json(f.rules, undefined),
        description: f.description,
      }) as TemplateFlag,
  );

  // ---- broadcast channels --------------------------------------------------
  const channels = ((await db
    .select({
      name: s.broadcastChannels.name,
      pattern: s.broadcastChannels.pattern,
      subscribe: s.broadcastChannels.subscribe,
      publish: s.broadcastChannels.publish,
      presence: s.broadcastChannels.presence,
      replay: s.broadcastChannels.replay,
      retentionHours: s.broadcastChannels.retentionHours,
    })
    .from(s.broadcastChannels)
    .where(mine(s.broadcastChannels))) as Record<string, unknown>[]).map(
    (c) =>
      compact({
        name: c.name,
        pattern: c.pattern,
        // subscribe/publish are TEXT columns holding JSON, not json-mode
        // columns — the seeder stringifies on the way in, so the export parses
        // on the way out or the target stores a string of a string.
        subscribe: json(c.subscribe, {}),
        publish: json(c.publish, {}),
        presence: bool(c.presence) ? true : undefined,
        replay: bool(c.replay) ? true : undefined,
        retentionHours: c.retentionHours,
      }) as TemplateChannel,
  );

  return {
    ...(roles.length ? { roles } : {}),
    ...(dashboards.length ? { dashboards } : {}),
    ...(kpis.length ? { kpis } : {}),
    ...(flows.length ? { flows } : {}),
    ...(documents.length ? { documents } : {}),
    ...(forms.length ? { forms } : {}),
    ...(agents.length ? { agents } : {}),
    ...(flags.length ? { flags } : {}),
    ...(channels.length ? { channels } : {}),
  };
};

/** Drop `undefined`/`null` keys so an exported document carries only what the
 *  workspace actually set — the same shape the hand-written catalog defs have,
 *  which is what makes an extract diffable against one in git. */
const compact = <T extends Record<string, unknown>>(o: T): Partial<T> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out as Partial<T>;
};

/** Walk every operation in a flow, including nested branches. Uses the one
 *  shared branch list so an op kind with a new branch key cannot be invisible
 *  here while being visible to the validator. */
const walkTemplateOps = (ops: unknown, visit: (op: Record<string, unknown>) => void): void => {
  if (!Array.isArray(ops)) return;
  for (const raw of ops) {
    if (!raw || typeof raw !== "object") continue;
    const op = raw as Record<string, unknown>;
    visit(op);
    for (const branch of OPERATION_BRANCH_KEYS) walkTemplateOps(op[branch], visit);
  }
};

/**
 * Export the workspace's managed collections as a reusable schema template:
 * collection defs (fields, flags, admin group) + the saved group-header order.
 * Collections are emitted in dependency order (relation targets first) so the
 * result applies cleanly into an empty workspace. Sample data is opt-in via
 * `sampleRows` (first N rows per collection, capped at the apply-side's 50):
 * hash/file/computed fields are skipped, relations become `{ ref }` links when
 * the target row made the same extract, and everything else round-trips.
 */
export async function extractTemplate(
  ctx: DbCtx,
  tenantId: string,
  opts: { collections?: string[]; sampleRows?: number; bundles?: boolean } = {},
): Promise<ExtractedTemplate> {
  const t = collectionsTable(ctx.dialect);
  const all = (await (ctx.db as never as { select: Function })
    .select({
      slug: t.slug,
      singular: t.singular,
      plural: t.plural,
      note: t.note,
      displayTemplate: t.displayTemplate,
      icon: t.icon,
      color: t.color,
      hidden: t.hidden,
      previewUrl: t.previewUrl,
      ownerScoped: t.ownerScoped,
      versioned: t.versioned,
      vectorize: t.vectorize,
      vectorizeModel: t.vectorizeModel,
      fts: t.fts,
      defaultSort: t.defaultSort,
      group: t.group,
      sortOrder: t.sortOrder,
      singleton: t.singleton,
      softDelete: t.softDelete,
      auditReads: t.auditReads,
      kanbanGroupBy: t.kanbanGroupBy,
      kanbanActionMap: t.kanbanActionMap,
      stagedEdits: t.stagedEdits,
      fields: t.fields,
    })
    .from(t)
    .where(
      and(eq(t.tenantId, tenantId), eq(t.adopted, false), eq(t.status, "active")),
    )) as ExtractRow[];

  const wanted = opts.collections?.length ? new Set(opts.collections) : null;
  const rows = wanted ? all.filter((r) => wanted.has(r.slug)) : all;
  if (rows.length === 0) {
    throw new AppError("VALIDATION", "No managed collections to extract");
  }
  // Deterministic base order BEFORE the (stable) topo-sort: group, then the
  // admin's in-group arrangement, then slug. Re-apply derives per-group
  // sortOrder from array position, so this is what preserves the admin's
  // ordering through the round-trip — and it fixes Postgres's unordered
  // SELECT making back-to-back extracts differ.
  rows.sort(
    (a, b) =>
      (a.group ?? "￿").localeCompare(b.group ?? "￿") ||
      (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.slug.localeCompare(b.slug),
  );

  // Kahn topo-sort on relation deps so relation targets precede dependents.
  // Deps outside the exported set are ignored (they can't be satisfied here);
  // any cycle falls back to original order for the remainder.
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const ordered: ExtractRow[] = [];
  const placed = new Set<string>();
  let pending = rows;
  while (pending.length > 0) {
    const ready = pending.filter((r) =>
      relationDeps(r).every((d) => !bySlug.has(d) || placed.has(d)),
    );
    const batch = ready.length > 0 ? ready : [pending[0] as ExtractRow];
    for (const r of batch) {
      ordered.push(r);
      placed.add(r.slug);
    }
    pending = pending.filter((r) => !placed.has(r.slug));
  }

  // Opt-in sample rows. Walk in dependency order so relation values can be
  // rewritten as `{ ref: "target:index" }` links against rows that made the
  // same extract; values pointing outside the window are dropped (a dangling
  // concrete id would be meaningless in the workspace the template lands in).
  const samplesBySlug = new Map<string, SampleRow[]>();
  if (opts.sampleRows && opts.sampleRows > 0) {
    const cap = Math.min(50, Math.floor(opts.sampleRows));
    const idIndex = new Map<string, Map<string, number>>();
    for (const r of ordered) {
      const physicalTable = derivePhysicalTable(tenantId, r.slug);
      const fields = (r.fields ?? []) as FieldDef[];
      const deletedWhere = r.softDelete
        ? sql` WHERE ${sql.identifier("deleted_at")} IS NULL`
        : sql``;
      let rows: Record<string, unknown>[];
      try {
        rows = await queryRows(
          ctx,
          sql`SELECT * FROM ${sql.identifier(physicalTable)}${deletedWhere} ORDER BY ${sql.identifier("created_at")} ASC LIMIT ${cap}`,
        );
      } catch {
        continue; // physical table missing/unreadable — emit schema only
      }
      const ids = new Map<string, number>();
      rows.forEach((row, i) => ids.set(String(row.id), i));
      idIndex.set(r.slug, ids);
      const samples: SampleRow[] = [];
      for (const row of rows) {
        const sample: SampleRow = {};
        for (const f of fields) {
          // Hash samples would seed plaintext where the API stores a digest;
          // file values are storage keys that don't exist in the target
          // workspace; computed columns re-derive on write.
          //
          // `sequence` and `rollup` are excluded for the same reason the apply
          // side refuses to write them: exporting the literal document numbers
          // would carry them into the next workspace around its counter, and
          // exporting a total would carry a number that contradicts the child
          // rows the extract may not even have taken. Both are re-derived on
          // apply — the numbers are allocated, the totals are refreshed.
          if (
            f.computed ||
            f.rollup ||
            f.sequence ||
            f.type === "hash" ||
            f.type === "file"
          )
            continue;
          let v = row[f.name];
          if (v == null) continue;
          if (f.type === "relation") {
            const idx = f.to ? idIndex.get(f.to)?.get(String(v)) : undefined;
            if (f.to && idx !== undefined) sample[f.name] = { ref: `${f.to}:${idx}` };
            continue;
          }
          if (f.type === "relation_many" || f.type === "json") {
            // sqlite stores JSON-ish columns as text — decode before emitting.
            if (typeof v === "string") {
              try {
                v = JSON.parse(v);
              } catch {
                /* keep the raw string */
              }
            }
            if (f.type === "relation_many") {
              const arr = Array.isArray(v) ? v : [];
              const refs = arr
                .map((x) => {
                  const idx = f.to ? idIndex.get(f.to)?.get(String(x)) : undefined;
                  return f.to && idx !== undefined ? { ref: `${f.to}:${idx}` } : null;
                })
                .filter((x): x is { ref: string } => x != null);
              if (refs.length) sample[f.name] = refs;
              continue;
            }
            sample[f.name] = v;
            continue;
          }
          if (f.type === "boolean") {
            sample[f.name] = Boolean(v);
            continue;
          }
          sample[f.name] = v instanceof Date ? v.toISOString() : v;
        }
        samples.push(sample);
      }
      if (samples.length) samplesBySlug.set(r.slug, samples);
    }
  }

  // Portal links do not live on the collection row — they are one workspace
  // setting holding a rule per person collection, which is why an extract that
  // only read `collections` could not see them at all.
  const savedPortal = await readSetting(ctx, tenantId, PORTAL_LINKS_KEY);
  const portalBySlug = new Map<string, { emailField: string; role: string }>();
  if (Array.isArray(savedPortal)) {
    for (const raw of savedPortal) {
      const p = raw as Partial<PortalLink>;
      if (typeof p?.collection === "string" && typeof p.emailField === "string" && typeof p.role === "string") {
        portalBySlug.set(p.collection, { emailField: p.emailField, role: p.role });
      }
    }
  }

  const savedGroups = await readSetting(ctx, tenantId, "collectionGroups");
  const usedGroups = new Set(ordered.map((r) => r.group).filter((g): g is string => !!g));
  const groups = (isStringArray(savedGroups) ? savedGroups : []).filter((g) =>
    usedGroups.has(g),
  );
  for (const g of usedGroups) if (!groups.includes(g)) groups.push(g);

  // Bundles are ON by default. An export that carried only tables unless you
  // asked is the shape that made a round-trip lose every role, flow and form a
  // workspace had — the default has to be "everything that can travel".
  const omissions: TemplateOmission[] = [];
  const bundles =
    opts.bundles === false
      ? {}
      : await extractBundles(
          ctx,
          tenantId,
          new Set(ordered.map((r) => r.slug)),
          (o) => omissions.push(o),
        );

  return {
    label: "Extracted schema",
    description: "Schema extracted from an existing workspace.",
    groups,
    collections: ordered.map((r) => ({
      slug: r.slug,
      ...(r.singular ? { singular: r.singular } : {}),
      ...(r.plural ? { plural: r.plural } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.displayTemplate ? { displayTemplate: r.displayTemplate } : {}),
      ...(r.icon ? { icon: r.icon } : {}),
      ...(r.color ? { color: r.color } : {}),
      ...(r.hidden ? { hidden: true } : {}),
      ...(r.previewUrl ? { previewUrl: r.previewUrl } : {}),
      ...(r.ownerScoped ? { ownerScoped: true } : {}),
      ...(r.versioned ? { versioned: true } : {}),
      ...(r.vectorize ? { vectorize: true } : {}),
      ...(r.vectorizeModel ? { vectorizeModel: r.vectorizeModel } : {}),
      ...(r.fts ? { fts: true } : {}),
      ...(r.defaultSort ? { defaultSort: r.defaultSort } : {}),
      ...(r.group ? { group: r.group } : {}),
      ...(r.sortOrder != null ? { sortOrder: r.sortOrder } : {}),
      ...(r.singleton ? { singleton: true } : {}),
      ...(r.softDelete ? { softDelete: true } : {}),
      ...(r.auditReads ? { auditReads: true } : {}),
      // The four an apply seeds and an extract used to drop on the floor. 21
      // catalog collections declare a Kanban grouping and 13 a portal link, so
      // a round-trip through extract silently un-configured both.
      ...(r.kanbanGroupBy ? { kanbanGroupBy: r.kanbanGroupBy } : {}),
      ...(r.kanbanActionMap ? { kanbanActionMap: r.kanbanActionMap } : {}),
      ...(r.stagedEdits ? { stagedEdits: true } : {}),
      ...(portalBySlug.has(r.slug) ? { portalLink: portalBySlug.get(r.slug) } : {}),
      fields: r.fields ?? [],
      ...(samplesBySlug.has(r.slug) ? { samples: samplesBySlug.get(r.slug) } : {}),
    })),
    ...bundles,
    ...(omissions.length ? { omissions } : {}),
  };
}

/** A custom (extracted / hand-written) template applied inline — the write
 *  half of {@link extractTemplate}'s round-trip. Shared by the REST route and
 *  the GraphQL mutation so both validate identically. The payload is
 *  admin-gated DDL, same trust level as POST /collections. */
export const CustomTemplateInput = z.object({
  label: z.string().max(80).optional(),
  description: z.string().max(500).optional(),
  // Caps sized so anything extractTemplate can emit round-trips back in:
  // groups matches the layout endpoint's 200-header cap; collections/fields
  // are generous sanity bounds (POST /collections itself caps neither).
  groups: z.array(z.string().min(1).max(60)).max(200).optional(),
  collections: z
    .array(
      z.object({
        slug: z.string().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/),
        singular: z.string().max(80).optional(),
        plural: z.string().max(80).optional(),
        note: z.string().max(500).optional(),
        displayTemplate: z.string().max(200).optional(),
        icon: z.string().max(60).optional(),
        color: z
          .string()
          .regex(/^([a-z]{2,30}|#[0-9a-fA-F]{6})$/)
          .optional(),
        hidden: z.boolean().optional(),
        previewUrl: z.string().max(500).regex(/^https?:\/\//).optional(),
        ownerScoped: z.boolean().optional(),
        versioned: z.boolean().optional(),
        vectorize: z.boolean().optional(),
        vectorizeModel: z.string().max(120).optional(),
        fts: z.boolean().optional(),
        defaultSort: z.string().max(120).optional(),
        group: z.string().min(1).max(60).optional(),
        sortOrder: z.number().int().min(0).max(100_000).optional(),
        singleton: z.boolean().optional(),
        softDelete: z.boolean().optional(),
        auditReads: z.boolean().optional(),
        kanbanGroupBy: z.string().max(60).optional(),
        // The same enum PATCH /collections enforces. A round-trip schema wider
        // than the endpoint that WRITES the column would let an apply store a
        // value the collection editor then refuses.
        kanbanActionMap: z.record(z.string(), z.enum(["publish", "unpublish", "archive"])).optional(),
        stagedEdits: z.boolean().optional(),
        portalLink: z
          .object({ emailField: z.string().min(1).max(60), role: z.string().min(1).max(60) })
          .optional(),
        fields: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
        samples: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
      }),
    )
    .min(1)
    .max(1000),
  // The bundle half. Everything `applyTemplateDefinition` can seed is accepted
  // here, because this schema is what a round-trip has to survive: it is a
  // plain `z.object`, so a key it does not name is STRIPPED IN SILENCE — which
  // is how an extract could grow nine new sections and still apply as bare
  // tables. Caps are generous sanity bounds; the shapes themselves are
  // re-validated by the seeders, which is where the real rules live (a form's
  // fields must be form-eligible, an agent's tools must exist, a flow's ops
  // must parse).
  roles: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        description: z.string().max(500).optional(),
        permissions: z
          .array(
            z.object({
              collection: z.string().min(1).max(60),
              action: z.enum(["read", "create", "update", "delete", "publish"]),
              fields: z.array(z.string().max(60)).max(500).optional(),
              condition: z.unknown().optional(),
            }),
          )
          .max(2000),
      }),
    )
    .max(200)
    .optional(),
  dashboards: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        panels: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              description: z.string().max(500).optional(),
              // Raw SQL is deliberately absent: a `sql` panel is bound to the
              // database it was written against, and the seeder refuses it.
              kind: z.enum(["items-aggregate", "static"]),
              viz: z.enum([
                "sparkline",
                "line",
                "area",
                "bars",
                "stacked-bars",
                "donut",
                "pie",
                "radar",
                "radial",
                "counter",
                "table",
              ]),
              config: z.record(z.string(), z.unknown()),
              layout: z
                .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
                .optional(),
            }),
          )
          .max(100),
      }),
    )
    .max(100)
    .optional(),
  kpis: z
    .array(
      z.object({
        slug: z.string().min(1).max(60),
        name: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        collection: z.string().min(1).max(60),
        agg: z.enum(["count", "sum", "avg", "min", "max"]),
        field: z.string().max(60).optional(),
        filter: z.record(z.string(), z.unknown()).optional(),
        dateField: z.string().max(60).optional(),
        groupBy: z.string().max(60).optional(),
        topN: z.number().int().min(1).max(1000).optional(),
        format: z.enum(["number", "money", "percent", "duration"]).optional(),
        unit: z.string().max(20).optional(),
        decimals: z.number().int().min(0).max(10).optional(),
        direction: z.enum(["up", "down", "neutral"]).optional(),
        alertOperator: z.enum(["above", "below", "change_above", "change_below"]).optional(),
        alertValue: z.number().optional(),
        pinTo: z.string().max(60).optional(),
        pinField: z.string().max(60).optional(),
      }),
    )
    .max(500)
    .optional(),
  flows: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        // POST /api/flows caps `trigger` at nothing, and a `schedule:` trigger
        // carries a JSON spec — the longest in the shipped catalog is already
        // 221 chars. A round-trip bound narrower than the endpoint that CREATES
        // the row makes a legitimate flow un-appliable, so this is a payload
        // guard, not a validity rule.
        trigger: z.string().min(1).max(4000),
        // Not `OperationSchema`: a flow authored elsewhere may carry an op this
        // deployment does not know, and the seeder's own validation is the
        // place that decides. Parsing here would refuse the whole template for
        // one unknown step.
        operations: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
        active: z.boolean().optional(),
      }),
    )
    .max(200)
    .optional(),
  documents: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        name: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        bodyHtml: z.string().min(1).max(200_000),
        headerHtml: z.string().max(50_000).optional(),
        footerHtml: z.string().max(50_000).optional(),
        pageOptions: z.record(z.string(), z.unknown()).optional(),
        filename: z.string().max(200).optional(),
        variables: z.array(z.string().max(60)).max(100).optional(),
      }),
    )
    .max(100)
    .optional(),
  forms: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        collection: z.string().min(1).max(60),
        fields: z
          .array(
            z.object({
              name: z.string().min(1).max(60),
              label: z.string().max(120).optional(),
              help: z.string().max(500).optional(),
            }),
          )
          .min(1)
          .max(100),
        settings: z.record(z.string(), z.unknown()).optional(),
        active: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  agents: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        handle: z.string().max(60).optional(),
        description: z.string().max(500).optional(),
        systemPrompt: z.string().min(1).max(50_000),
        tools: z.array(z.string().max(80)).max(400),
        model: z.string().max(200).optional(),
        maxSteps: z.number().int().min(1).max(50).optional(),
        memory: z.boolean().optional(),
        active: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  flags: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        enabled: z.boolean().optional(),
        value: z.unknown().optional(),
        rules: z.record(z.string(), z.unknown()).optional(),
        description: z.string().max(500).optional(),
      }),
    )
    .max(500)
    .optional(),
  channels: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        pattern: z.string().min(1).max(200),
        subscribe: z.record(z.string(), z.unknown()),
        publish: z.record(z.string(), z.unknown()),
        presence: z.boolean().optional(),
        replay: z.boolean().optional(),
        retentionHours: z.number().int().min(1).max(8760).optional(),
      }),
    )
    .max(200)
    .optional(),
  // Accepted and ignored: an extract emits its omissions so a human reading the
  // file knows what did not come with it, and re-applying that same file must
  // not fail on a key the exporter wrote. Stripping it silently would be the
  // very behaviour this commit exists to end, so it is named and dropped.
  omissions: z
    .array(
      z.object({
        resource: z.string().max(200),
        what: z.string().max(500),
        reason: z.string().max(1000),
      }),
    )
    .max(2000)
    .optional(),
});

/** Valid field-type tokens, from the canonical list in @backlex/db
 *  (`validateFields` checks names/flags but not the type token itself). */
const VALID_FIELD_TYPES = new Set<string>(FIELD_TYPES);

/** Zod-parse + deep field-validate an inline template payload into the
 *  engine's {@link SchemaTemplate} shape. Throws `AppError("VALIDATION")`. */
export const parseCustomTemplate = (input: unknown): SchemaTemplate => {
  const parsed = CustomTemplateInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid template");
  }
  for (const col of parsed.data.collections) {
    for (const f of col.fields) {
      const name = typeof f.name === "string" ? f.name : "?";
      if (typeof f.type !== "string" || !VALID_FIELD_TYPES.has(f.type)) {
        throw new AppError(
          "VALIDATION",
          `Collection "${col.slug}": field "${name}" has unknown type "${String(f.type)}"`,
        );
      }
    }
    try {
      validateFields(col.fields as unknown as FieldDef[]);
    } catch (e) {
      throw new AppError("VALIDATION", `Collection "${col.slug}": ${(e as Error).message}`);
    }
  }
  const d = parsed.data;
  return {
    id: "custom",
    label: d.label ?? "Custom template",
    description: d.description ?? "",
    groups: d.groups,
    collections: d.collections.map((col) => ({
      ...col,
      fields: col.fields as unknown as FieldDef[],
    })),
    // Every bundle the payload carried, forwarded to the same seeders a catalog
    // apply uses. Listing them one by one rather than spreading `d` is
    // deliberate: `omissions` is accepted for round-trip reasons and must NOT
    // reach the engine, and a spread would carry it plus anything a later zod
    // key adds.
    ...(d.roles ? { roles: d.roles as unknown as TemplateRole[] } : {}),
    ...(d.dashboards ? { dashboards: d.dashboards as unknown as TemplateDashboard[] } : {}),
    ...(d.kpis ? { kpis: d.kpis as unknown as TemplateKpi[] } : {}),
    ...(d.flows ? { flows: d.flows as unknown as TemplateFlow[] } : {}),
    ...(d.documents ? { documents: d.documents as unknown as TemplateDocument[] } : {}),
    ...(d.forms ? { forms: d.forms as unknown as TemplateForm[] } : {}),
    ...(d.agents ? { agents: d.agents as unknown as TemplateAgent[] } : {}),
    ...(d.flags ? { flags: d.flags as unknown as TemplateFlag[] } : {}),
    ...(d.channels ? { channels: d.channels as unknown as TemplateChannel[] } : {}),
  };
};
