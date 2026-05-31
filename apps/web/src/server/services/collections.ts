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
  ownerScoped?: boolean;
  tenantScoped?: boolean;
  versioned?: boolean;
  vectorize?: boolean;
  vectorizeModel?: string | null;
  defaultSort?: string | null;
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
    fields: def.fields,
    ownerScoped: def.ownerScoped ?? false,
    tenantScoped,
    versioned: def.versioned ?? false,
    vectorize: def.vectorize ?? false,
    vectorizeModel: def.vectorizeModel ?? null,
    defaultSort: def.defaultSort ?? null,
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
    adopted: false,
  });

  if (def.ownerScoped) {
    await seedOwnerScopedPermissions(ctx, tenantId, def.slug);
    invalidateTenantPermissions(tenantId);
  }

  return { slug: def.slug, created: true };
}
