import { and, eq, sql } from "drizzle-orm";
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
import { AppError } from "@backlex/core";
import {
  getTemplate,
  type SampleRow,
  type SampleValue,
  type SchemaTemplate,
  type TemplateCollection,
  type TemplateDashboard,
  type TemplateRole,
} from "../templates/catalog";
import type { Ctx } from "../context";
import { createManagedCollection } from "./collections";
import { invalidateTenantCollections } from "./collections-cache";
import { invalidateTenantPermissions } from "./permissions-cache";
import { indexFts, isSearchable } from "./fts";
import {
  deleteVectors,
  embedAndUpsertBatch,
  isVectorizable,
  type VectorizeMeta,
} from "./vectorize";
import { serialize, nowFor } from "./items-helpers";
import { ensureSystemRoles, type DbCtx } from "./seed";
import { mergePortalLink } from "./portal-links";

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
  /** Names of bundled roles created by this apply (existing names skipped). */
  roles: string[];
  /** Names of bundled dashboards created by this apply (existing names skipped). */
  dashboards: string[];
}

/** Map of `slug -> [insertedId, …]` for already-seeded collections, used to
 *  resolve `{ ref: "slug:index" }` sample references to real ids. */
type SeededIds = Record<string, string[]>;

const isSampleRef = (v: unknown): v is { ref: string } =>
  typeof v === "object" && v !== null && "ref" in v &&
  typeof (v as { ref: unknown }).ref === "string";

/** Resolve a sample value: `{ ref }` → the referenced id (or null if the target
 *  wasn't seeded), arrays element-wise, everything else passes through. */
const resolveSample = (value: SampleValue, seeded: SeededIds): unknown => {
  if (isSampleRef(value)) {
    const [slug, idx] = value.ref.split(":");
    return seeded[slug ?? ""]?.[Number(idx)] ?? null;
  }
  if (Array.isArray(value)) return value.map((v) => resolveSample(v, seeded));
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
): Promise<{ ids: string[]; rows: Array<{ id: string; row: Record<string, unknown> }> }> {
  const rows = col.samples ?? [];
  if (rows.length === 0) return { ids: [], rows: [] };
  const physicalTable = derivePhysicalTable(tenantId, col.slug);
  const fieldByName = new Map(col.fields.map((f) => [f.name, f]));
  const ids: string[] = [];
  const seededRows: Array<{ id: string; row: Record<string, unknown> }> = [];
  const ftsTarget = { fts: !!col.fts, physicalTable, pkColumn: "id", fields: col.fields };
  const searchable = isSearchable(ftsTarget);

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
    for (const [key, value] of Object.entries(sample)) {
      const def = fieldByName.get(key);
      // Skipped: unknown/computed fields, `hash` — a sample would land as
      // plaintext where the API stores a scrypt digest — and presentational
      // layout blocks, which own no column at all (custom templates can send
      // anything; catalog templates never sample either).
      if (!def || def.computed || def.type === "hash" || isPresentational(def)) continue;
      const resolved = resolveSample(value, seeded);
      raw[def.name] = resolved;
      let serialized = serialize(resolved, def.type, ctx.dialect);
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
  return { ids, rows: seededRows };
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

/** Seed bundled insights dashboards + panels. A dashboard whose name already
 *  exists in the workspace is skipped wholesale, mirroring `seedRoles`. */
async function seedDashboards(
  ctx: DbCtx,
  tenantId: string,
  dashboards: TemplateDashboard[],
): Promise<string[]> {
  if (dashboards.length === 0) return [];
  const t =
    ctx.dialect === "pg"
      ? { dashboards: pg.schema.dashboards, panels: pg.schema.savedPanels }
      : { dashboards: sqlite.schema.dashboards, panels: sqlite.schema.savedPanels };
  const created: string[] = [];
  for (const dash of dashboards) {
    const existing = await (ctx.db as never as { select: Function })
      .select({ id: t.dashboards.id })
      .from(t.dashboards)
      .where(and(eq(t.dashboards.tenantId, tenantId), eq(t.dashboards.name, dash.name)))
      .limit(1);
    if (existing[0]) continue;
    const dashboardId = crypto.randomUUID();
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
  return created;
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

  const roles = await seedRoles(ctx, tenantId, template.roles ?? []);
  const dashboards = await seedDashboards(ctx, tenantId, template.dashboards ?? []);

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
  return { templateId: template.id, created, skipped, seeded, roles, dashboards };
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
export interface ExtractedTemplate {
  label: string;
  description: string;
  groups: string[];
  collections: TemplateCollection[];
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
  opts: { collections?: string[]; sampleRows?: number } = {},
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
          if (f.computed || f.type === "hash" || f.type === "file") continue;
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

  const savedGroups = await readSetting(ctx, tenantId, "collectionGroups");
  const usedGroups = new Set(ordered.map((r) => r.group).filter((g): g is string => !!g));
  const groups = (isStringArray(savedGroups) ? savedGroups : []).filter((g) =>
    usedGroups.has(g),
  );
  for (const g of usedGroups) if (!groups.includes(g)) groups.push(g);

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
      fields: r.fields ?? [],
      ...(samplesBySlug.has(r.slug) ? { samples: samplesBySlug.get(r.slug) } : {}),
    })),
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
        fields: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
        samples: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
      }),
    )
    .min(1)
    .max(1000),
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
  return {
    id: "custom",
    label: parsed.data.label ?? "Custom template",
    description: parsed.data.description ?? "",
    groups: parsed.data.groups,
    collections: parsed.data.collections.map((col) => ({
      ...col,
      fields: col.fields as unknown as FieldDef[],
    })),
  };
};
