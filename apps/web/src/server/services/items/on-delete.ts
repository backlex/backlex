import { eq, sql, type SQL } from "drizzle-orm";
import type { FieldDef } from "@backlex/db";
import type { Ctx } from "../../context";
import { deleteVector } from "../vectorize";
import { deleteFts } from "../fts";
import { collectionsTable, loadCollection } from "./collection-loader";
import { queryAll } from "./sql-helpers";

/**
 * App-layer ON DELETE relational triggers. backlex keeps no DB-level foreign
 * keys (v1 — see FieldDef.to), so referential actions are emulated here: when a
 * row in `targetSlug` is deleted, every OTHER collection that has a single
 * `relation` field pointing at it with an `onDelete` action gets fixed up.
 *
 *  - `set_null` → the referencing FK column is set to NULL.
 *  - `cascade`  → the referencing rows are deleted (one level; their own
 *    vector/FTS index entries are cleaned up best-effort).
 *
 * v1 scope: single `relation` FKs only (not `relation_many` JSON arrays), one
 * level deep (a cascaded row's own `onDelete` triggers do NOT chain), and
 * cascaded deletes don't emit per-row realtime/changefeed events. Prefer
 * `set_null` for realtime-synced targets.
 */

interface RefTarget {
  slug: string;
  physicalTable: string;
  tenantScoped: boolean;
  pkColumn: string;
  field: FieldDef;
}

/** All active collections in the tenant that reference `targetSlug` via a
 *  single `relation` field carrying an actionable `onDelete`. */
const findReferencingRelations = async (
  ctx: Ctx,
  tenantId: string,
  targetSlug: string,
): Promise<RefTarget[]> => {
  const t = collectionsTable(ctx.dialect);
  const rows = (await (ctx.db as any).select().from(t).where(eq(t.tenantId, tenantId))) as Record<
    string,
    unknown
  >[];
  const out: RefTarget[] = [];
  for (const r of rows) {
    if (((r.status ?? "active") as string) !== "active") continue;
    const fields = (r.fields ?? []) as FieldDef[];
    for (const f of fields) {
      if (
        f.type === "relation" &&
        f.to === targetSlug &&
        (f.onDelete === "set_null" || f.onDelete === "cascade")
      ) {
        out.push({
          slug: r.slug as string,
          physicalTable: (r.physicalTable ?? r.physical_table) as string,
          tenantScoped: (r.tenantScoped ?? r.tenant_scoped ?? true) ? true : false,
          pkColumn: ((r.pkColumn ?? r.pk_column) as string | undefined) ?? "id",
          field: f,
        });
      }
    }
  }
  return out;
};

export const enforceOnDeleteTriggers = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  targetSlug: string,
  deletedId: string,
  run: (stmt: SQL) => Promise<void>,
): Promise<void> => {
  if (!tenantId) return;
  const refs = await findReferencingRelations(ctx, tenantId, targetSlug);
  for (const ref of refs) {
    const table = sql.identifier(ref.physicalTable);
    const fk = sql.identifier(ref.field.name);
    const scope = ref.tenantScoped
      ? sql` AND ${sql.identifier("tenant_id")} = ${tenantId}`
      : sql``;
    if (ref.field.onDelete === "set_null") {
      await run(sql`UPDATE ${table} SET ${fk} = NULL WHERE ${fk} = ${deletedId}${scope}`);
      continue;
    }
    // cascade — capture the ids first so their vector/FTS index rows can be
    // cleaned up after the delete (self-gated no-op unless configured).
    const pk = sql.identifier(ref.pkColumn);
    const victims = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${pk} AS pk FROM ${table} WHERE ${fk} = ${deletedId}${scope}`,
    );
    await run(sql`DELETE FROM ${table} WHERE ${fk} = ${deletedId}${scope}`);
    if (victims.length > 0) {
      const cRow = await loadCollection(ctx, tenantId, ref.slug);
      for (const v of victims) {
        const cid = String(v.pk);
        await deleteVector(ctx, cRow, tenantId, cid).catch(() => {});
        await deleteFts(ctx, cRow, cid).catch(() => {});
      }
    }
  }
};
