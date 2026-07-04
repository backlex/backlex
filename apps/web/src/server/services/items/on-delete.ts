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
 * row in `targetSlug` is deleted, every OTHER active collection that references
 * it with an `onDelete` action gets fixed up.
 *
 *  - `set_null` → a `relation` FK column is set NULL; a `relation_many` JSON
 *    array has the deleted id removed from it.
 *  - `cascade`  → the referencing rows are deleted, their vector/FTS index
 *    entries cleaned up best-effort, and their OWN `onDelete` triggers chained
 *    (bounded by a visited-set so relation cycles terminate).
 *
 * v1 caveats: `relation_many` matching scans the referencing collection's rows
 * (capped — see MANY_SCAN_CAP), so keep those collections modestly sized; and
 * cascaded deletes still don't emit per-row realtime/changefeed events (the
 * parent delete event fires) — prefer `set_null` for realtime-synced targets.
 */

/** Safety bound on a relation_many scan — a warning is logged if hit. */
const MANY_SCAN_CAP = 20000;

interface RefTarget {
  slug: string;
  physicalTable: string;
  tenantScoped: boolean;
  pkColumn: string;
  field: FieldDef;
}

/** All active collections in the tenant that reference `targetSlug` via a
 *  `relation` / `relation_many` field carrying an actionable `onDelete`. */
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
        (f.type === "relation" || f.type === "relation_many") &&
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

const parseIdArray = (raw: unknown): string[] => {
  const arr = typeof raw === "string" ? safeJson(raw) : raw;
  return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
};

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Bind a JSON array as the correct column type for each dialect. */
const jsonArrayLiteral = (arr: string[], dialect: "pg" | "sqlite"): SQL => {
  const text = JSON.stringify(arr);
  return dialect === "pg" ? sql`${text}::jsonb` : sql`${text}`;
};

export const enforceOnDeleteTriggers = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  targetSlug: string,
  deletedId: string,
  run: (stmt: SQL) => Promise<void>,
  visited: Set<string> = new Set(),
): Promise<void> => {
  if (!tenantId) return;
  // Cycle / re-entry guard for cascade chaining.
  const key = `${targetSlug}:${deletedId}`;
  if (visited.has(key)) return;
  visited.add(key);

  const refs = await findReferencingRelations(ctx, tenantId, targetSlug);
  for (const ref of refs) {
    const table = sql.identifier(ref.physicalTable);
    const fk = sql.identifier(ref.field.name);
    const pk = sql.identifier(ref.pkColumn);
    const scope = ref.tenantScoped
      ? sql` AND ${sql.identifier("tenant_id")} = ${tenantId}`
      : sql``;
    const cascade = ref.field.onDelete === "cascade";

    if (ref.field.type === "relation") {
      if (!cascade) {
        await run(sql`UPDATE ${table} SET ${fk} = NULL WHERE ${fk} = ${deletedId}${scope}`);
        continue;
      }
      const victims = (
        await queryAll<Record<string, unknown>>(
          ctx,
          sql`SELECT ${pk} AS pk FROM ${table} WHERE ${fk} = ${deletedId}${scope}`,
        )
      ).map((v) => String(v.pk));
      await run(sql`DELETE FROM ${table} WHERE ${fk} = ${deletedId}${scope}`);
      await afterCascade(ctx, tenantId, ref, victims, run, visited);
      continue;
    }

    // relation_many — the FK is a JSON array; match by scanning the rows.
    const candidates = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${pk} AS pk, ${fk} AS arr FROM ${table} WHERE 1=1${scope} LIMIT ${MANY_SCAN_CAP}`,
    );
    if (candidates.length >= MANY_SCAN_CAP) {
      console.warn(
        `[on-delete] relation_many scan on "${ref.slug}.${ref.field.name}" hit the ${MANY_SCAN_CAP}-row cap; some references may not be fixed.`,
      );
    }
    const matched = candidates.filter((row) => parseIdArray(row.arr).includes(deletedId));
    if (matched.length === 0) continue;

    if (!cascade) {
      for (const row of matched) {
        const next = parseIdArray(row.arr).filter((x) => x !== deletedId);
        await run(
          sql`UPDATE ${table} SET ${fk} = ${jsonArrayLiteral(next, ctx.dialect)} WHERE ${pk} = ${String(row.pk)}${scope}`,
        );
      }
      continue;
    }
    const victims = matched.map((row) => String(row.pk));
    for (const vid of victims) {
      await run(sql`DELETE FROM ${table} WHERE ${pk} = ${vid}${scope}`);
    }
    await afterCascade(ctx, tenantId, ref, victims, run, visited);
  }
};

/** Post-cascade housekeeping: clean the deleted rows' vector/FTS index entries
 *  and chain each row's own ON DELETE triggers (bounded by `visited`). */
const afterCascade = async (
  ctx: Ctx,
  tenantId: string,
  ref: RefTarget,
  victimIds: string[],
  run: (stmt: SQL) => Promise<void>,
  visited: Set<string>,
): Promise<void> => {
  if (victimIds.length === 0) return;
  const cRow = await loadCollection(ctx, tenantId, ref.slug).catch(() => null);
  for (const vid of victimIds) {
    if (cRow) {
      await deleteVector(ctx, cRow, tenantId, vid).catch(() => {});
      await deleteFts(ctx, cRow, vid).catch(() => {});
    }
    // Chain: the cascaded row may itself be referenced by other collections.
    await enforceOnDeleteTriggers(ctx, tenantId, ref.slug, vid, run, visited);
  }
};
