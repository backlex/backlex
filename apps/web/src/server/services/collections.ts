import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { applyCollection, derivePhysicalTable, tableExists, type FieldDef } from "@backlex/db";
import { seedOwnerScopedPermissions, type DbCtx } from "./seed";
import { invalidateTenantPermissions } from "./permissions-cache";

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

/** A managed collection definition (no `adopted` — that path stays in the route). */
export interface ManagedCollectionDef {
  slug: string;
  fields: FieldDef[];
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  displayTemplate?: string | null;
  /** Admin icon key (presentational). */
  icon?: string | null;
  /** Admin accent color — preset token or `#rrggbb` (presentational). */
  color?: string | null;
  /** Hidden from the admin sidebar/index (presentational). */
  hidden?: boolean;
  /** Preview-URL template with `{{field}}` placeholders. */
  previewUrl?: string | null;
  /** Admin Kanban group-by field (presentational). */
  kanbanGroupBy?: string | null;
  /** Kanban column → lifecycle action map (presentational). */
  kanbanActionMap?: Record<string, string> | null;
  ownerScoped?: boolean;
  tenantScoped?: boolean;
  versioned?: boolean;
  vectorize?: boolean;
  vectorizeModel?: string | null;
  /** Enable keyword full-text search — pairs with `searchable` fields. */
  fts?: boolean;
  defaultSort?: string | null;
  /** Admin grouping: section header on the Collections page + sidebar tree.
   *  Header order lives in the `collectionGroups` app_settings key. */
  group?: string | null;
  /** Manual position within the group. Null sorts after ordered rows. */
  sortOrder?: number | null;
  /** Single-row collection (settings-style). Metadata-only flag. */
  singleton?: boolean;
  /** Adds a nullable `deleted_at` column; deletes become soft. */
  softDelete?: boolean;
  /** Write access-audit rows on reads of this collection. Metadata-only. */
  auditReads?: boolean;
}

/**
 * Create one managed collection for a workspace: insert the `collections` row,
 * materialize the physical table via `applyCollection`, and seed owner-scoped
 * permissions when requested. Reuses the same primitives as the HTTP route.
 *
 * Idempotent at the slug level — if the workspace already has a collection with
 * this slug it's left untouched and `created: false` is returned, so applying a
 * template twice (or over a partially-seeded workspace) is safe.
 */
export async function createManagedCollection(
  ctx: DbCtx,
  tenantId: string,
  def: ManagedCollectionDef,
): Promise<{ slug: string; created: boolean }> {
  const { db, dialect } = ctx;
  const t = collectionsTable(dialect);

  const existing = await (db as never as { select: Function })
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, def.slug)))
    .limit(1);
  if (existing[0]) return { slug: def.slug, created: false };

  const physicalTable = derivePhysicalTable(tenantId, def.slug);
  // If the physical table somehow exists already, skip rather than throw —
  // template application must never abort a half-seeded workspace.
  if (await tableExists(db, dialect, physicalTable)) {
    return { slug: def.slug, created: false };
  }

  const tenantScoped = def.tenantScoped ?? true;
  await (db as never as { insert: Function }).insert(t).values({
    id: crypto.randomUUID(),
    slug: def.slug,
    tenantId,
    physicalTable,
    singular: def.singular ?? null,
    plural: def.plural ?? null,
    note: def.note ?? null,
    displayTemplate: def.displayTemplate ?? null,
    icon: def.icon ?? null,
    color: def.color ?? null,
    hidden: def.hidden ?? false,
    previewUrl: def.previewUrl ?? null,
    kanbanGroupBy: def.kanbanGroupBy ?? null,
    kanbanActionMap: def.kanbanActionMap ?? null,
    fields: def.fields,
    ownerScoped: def.ownerScoped ?? false,
    tenantScoped,
    versioned: def.versioned ?? false,
    vectorize: def.vectorize ?? false,
    vectorizeModel: def.vectorizeModel ?? null,
    fts: def.fts ?? false,
    defaultSort: def.defaultSort ?? null,
    group: def.group ?? null,
    sortOrder: def.sortOrder ?? null,
    singleton: def.singleton ?? false,
    softDelete: def.softDelete ?? false,
    auditReads: def.auditReads ?? false,
    adopted: false,
    pkColumn: "id",
    hasCreatedAt: true,
    hasUpdatedAt: true,
  });

  await applyCollection(db, dialect, {
    table: physicalTable,
    fields: def.fields,
    ownerScoped: def.ownerScoped ?? false,
    tenantScoped,
    versioned: def.versioned ?? false,
    fts: def.fts ?? false,
    softDelete: def.softDelete ?? false,
    adopted: false,
  });

  if (def.ownerScoped) {
    await seedOwnerScopedPermissions(ctx, tenantId, def.slug);
    invalidateTenantPermissions(tenantId);
  }

  return { slug: def.slug, created: true };
}

/**
 * Clone a collection's SCHEMA (fields + metadata) into a new managed
 * collection. Data is never copied. The clone is always managed, even when the
 * source is adopted — the field definitions become fresh DDL on a new
 * `c_<tenant>_<slug>` table with the conventional uuid `id` PK. FTS/vectorize
 * flags carry over but no backfill runs (the table starts empty).
 *
 * Shared by REST (`POST /collections/:slug/clone`), GraphQL, SDK, and CLI so
 * validation and guards live in exactly one place.
 *
 * Throws `Error` with a message suitable for AppError wrapping; the caller
 * maps to transport-specific errors.
 */
export async function cloneCollection(
  ctx: DbCtx,
  tenantId: string,
  sourceSlug: string,
  newSlug: string,
): Promise<{ slug: string }> {
  const { db, dialect } = ctx;
  const t = collectionsTable(dialect);

  const rows = await (db as never as { select: Function })
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, sourceSlug)))
    .limit(1);
  const src = rows[0] as Record<string, unknown> | undefined;
  if (!src || (src.status as string) === "archived") {
    throw new Error("SOURCE_NOT_FOUND");
  }

  const res = await createManagedCollection(ctx, tenantId, {
    slug: newSlug,
    fields: src.fields as FieldDef[],
    singular: (src.singular as string | null) ?? null,
    plural: (src.plural as string | null) ?? null,
    note: (src.note as string | null) ?? null,
    displayTemplate: (src.displayTemplate as string | null) ?? null,
    icon: (src.icon as string | null) ?? null,
    color: (src.color as string | null) ?? null,
    hidden: Boolean(src.hidden),
    previewUrl: (src.previewUrl as string | null) ?? null,
    kanbanGroupBy: (src.kanbanGroupBy as string | null) ?? null,
    kanbanActionMap:
      (src.kanbanActionMap as Record<string, string> | null) ?? null,
    ownerScoped: Boolean(src.ownerScoped),
    tenantScoped: src.tenantScoped !== false,
    versioned: Boolean(src.versioned),
    vectorize: Boolean(src.vectorize),
    vectorizeModel: (src.vectorizeModel as string | null) ?? null,
    fts: Boolean(src.fts),
    defaultSort: (src.defaultSort as string | null) ?? null,
    group: (src.group as string | null) ?? null,
    // Deliberately NOT copying sortOrder — the clone appends after the
    // ordered rows in its group instead of colliding with the source's slot.
    singleton: Boolean(src.singleton),
    softDelete: Boolean(src.softDelete),
    auditReads: Boolean(src.auditReads),
  });
  if (!res.created) throw new Error("SLUG_TAKEN");
  return { slug: newSlug };
}
