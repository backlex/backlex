import { and, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { derivePhysicalTable } from "@backlex/db";
import { AppError } from "@backlex/core";
import {
  getTemplate,
  type SampleRow,
  type SampleValue,
  type TemplateCollection,
} from "../templates/catalog";
import { createManagedCollection } from "./collections";
import { serialize, nowFor } from "./items-helpers";
import { ensureSystemRoles, type DbCtx } from "./seed";

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

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

/**
 * Seed a collection's sample rows. Inserts directly into the physical table
 * (admin-trust, like the flow path in items-helpers) and returns the new ids in
 * sample order so later collections can `ref` them. Versioned collections are
 * seeded as published so demo data is visible without an extra publish step.
 *
 * Note: this does not maintain the FTS / vector indexes — sample rows in
 * searchable collections need a `fts-reindex` / `vectorize` backfill to become
 * searchable. Acceptable for starter demo data.
 */
async function seedSamples(
  ctx: DbCtx,
  tenantId: string,
  col: TemplateCollection,
  seeded: SeededIds,
): Promise<string[]> {
  const rows = col.samples ?? [];
  if (rows.length === 0) return [];
  const physicalTable = derivePhysicalTable(tenantId, col.slug);
  const fieldByName = new Map(col.fields.map((f) => [f.name, f]));
  const ids: string[] = [];

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

    for (const [key, raw] of Object.entries(sample)) {
      const def = fieldByName.get(key);
      if (!def || def.computed) continue;
      cols.push(def.name);
      vals.push(serialize(resolveSample(raw, seeded), def.type, ctx.dialect));
    }

    const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
    const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
    await exec(
      ctx,
      sql`INSERT INTO ${sql.identifier(physicalTable)} (${colSql}) VALUES (${valSql})`,
    );
    ids.push(id);
  }
  return ids;
}

/**
 * Seed a vertical template's collections into a workspace. Ensures system roles
 * exist, then creates each collection in dependency order (relation targets
 * first). Idempotent — collections that already exist are skipped, so a re-apply
 * or a partially-seeded workspace converges cleanly.
 */
export async function applyTemplate(
  ctx: DbCtx,
  tenantId: string,
  templateId: string,
): Promise<ApplyTemplateResult> {
  const template = getTemplate(templateId);
  if (!template) throw new AppError("VALIDATION", `Unknown template "${templateId}"`);

  await ensureSystemRoles(ctx, tenantId);

  const created: string[] = [];
  const skipped: string[] = [];
  const seededIds: SeededIds = {};
  let seeded = 0;
  for (const col of template.collections) {
    const res = await createManagedCollection(ctx, tenantId, col);
    (res.created ? created : skipped).push(res.slug);
    // Only seed freshly-created collections — re-applying over an existing
    // workspace must never duplicate sample rows.
    if (res.created && col.samples?.length) {
      const ids = await seedSamples(ctx, tenantId, col, seededIds);
      seededIds[col.slug] = ids;
      seeded += ids.length;
    }
  }
  return { templateId, created, skipped, seeded };
}
