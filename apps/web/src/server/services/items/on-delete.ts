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
 * A second, narrower pass handles POLYMORPHIC references — a `(collection,
 * row_id)` pair carrying `polymorphicRef` + `onDelete: "cascade"`, which is
 * what a translations / attachments / comments table looks like. Those cannot
 * be a `relation` (the target is a value, not a schema fact) so nothing
 * collected them: a deleted product left its translated name and description
 * behind permanently, and the first symptom is a translations table larger
 * than the catalogue it describes.
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

/**
 * A collection that references rows POLYMORPHICALLY — a `(collection, row_id)`
 * pair rather than a typed FK — and asks for its rows to go when the row they
 * describe does.
 *
 * The shape a translations / attachments / comments table settles on. It can
 * carry no `to`, so `findReferencingRelations` cannot see it, and nothing
 * cleaned these rows up: a deleted product left its translated name and
 * description behind permanently, joining to nothing and never collected.
 */
interface PolyRefTarget {
  slug: string;
  physicalTable: string;
  tenantScoped: boolean;
  /** Column holding the target's collection slug. */
  collectionColumn: string;
  /** Column holding the target row's id. */
  rowIdColumn: string;
}

/**
 * The tenant's ACTIVE collection rows, read once per trigger pass.
 *
 * Both scans below want the same rows, and a cascade chain re-enters this
 * function for every row it deletes — so reading the table twice per hop
 * doubles the cost of the deepest thing here for nothing.
 */
const activeCollections = async (
  ctx: Ctx,
  tenantId: string,
): Promise<Record<string, unknown>[]> => {
  const t = collectionsTable(ctx.dialect);
  const rows = (await (ctx.db as any).select().from(t).where(eq(t.tenantId, tenantId))) as Record<
    string,
    unknown
  >[];
  return rows.filter((r) => ((r.status ?? "active") as string) === "active");
};

/** Collections that reference `targetSlug` via a `relation` / `relation_many`
 *  field carrying an actionable `onDelete`. */
const findReferencingRelations = (
  rows: Record<string, unknown>[],
  targetSlug: string,
): RefTarget[] => {
  const out: RefTarget[] = [];
  for (const r of rows) {
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

/**
 * Collections carrying a cascading polymorphic reference.
 *
 * Unlike {@link findReferencingRelations} this cannot filter by target — the
 * target lives in a COLUMN, not in the schema — so it returns every such
 * collection and the `WHERE <collectionColumn> = <targetSlug>` does the
 * narrowing. That also means the sweep is bounded by an index on the pair
 * rather than by a scan: those two columns are the ones such a table already
 * reads by, and the template that declares one indexes both.
 */
const findPolymorphicRefs = (rows: Record<string, unknown>[]): PolyRefTarget[] => {
  const out: PolyRefTarget[] = [];
  for (const r of rows) {
    const fields = (r.fields ?? []) as FieldDef[];
    for (const f of fields) {
      if (!f.polymorphicRef || f.onDelete !== "cascade") continue;
      const collectionColumn = f.polymorphicRef.collectionField;
      // Stored field metadata is untrusted — a collection row can predate a
      // rename, or be written by hand. `validateFields` refuses a pair naming a
      // column that is not on the collection, but this is the read side and it
      // must not build an identifier out of a name nothing confirms: skip it
      // rather than emit SQL that fails mid-delete, on somebody's production
      // data, in a path nothing exercises until then.
      //
      // It is also what keeps the identifier safe. A field NAME is validated
      // `^[a-z][a-z0-9_]*$`, so requiring the pair to match one means the
      // column spliced below is always a checked identifier.
      if (!fields.some((o) => o.name === collectionColumn)) continue;
      out.push({
        slug: r.slug as string,
        physicalTable: (r.physicalTable ?? r.physical_table) as string,
        tenantScoped: (r.tenantScoped ?? r.tenant_scoped ?? true) ? true : false,
        collectionColumn,
        rowIdColumn: f.name,
      });
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
  /** Slugs whose rows these triggers changed, accumulated across the cascade
   *  chain. The caller uses it to restate any rollup that summarises one of
   *  them — see the note on `rollupRefreshAllStatements`. */
  touched: Set<string> = new Set(),
): Promise<Set<string>> => {
  if (!tenantId) return touched;
  // Cycle / re-entry guard for cascade chaining.
  const key = `${targetSlug}:${deletedId}`;
  if (visited.has(key)) return touched;
  visited.add(key);

  const collections = await activeCollections(ctx, tenantId);
  const refs = findReferencingRelations(collections, targetSlug);
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
        touched.add(ref.slug);
        continue;
      }
      const victims = (
        await queryAll<Record<string, unknown>>(
          ctx,
          sql`SELECT ${pk} AS pk FROM ${table} WHERE ${fk} = ${deletedId}${scope}`,
        )
      ).map((v) => String(v.pk));
      await run(sql`DELETE FROM ${table} WHERE ${fk} = ${deletedId}${scope}`);
      touched.add(ref.slug);
      await afterCascade(ctx, tenantId, ref, victims, run, visited, touched);
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
      touched.add(ref.slug);
      continue;
    }
    const victims = matched.map((row) => String(row.pk));
    for (const vid of victims) {
      await run(sql`DELETE FROM ${table} WHERE ${pk} = ${vid}${scope}`);
    }
    touched.add(ref.slug);
    await afterCascade(ctx, tenantId, ref, victims, run, visited, touched);
  }

  // Polymorphic references, second because they cannot chain: a translations
  // row describes something, it is not itself described, so there is nothing
  // below it to cascade into. Deleting them last also means the relation
  // cascade above has already produced whatever rows it was going to produce —
  // and each of those runs its OWN pass through here, so a cascaded child's
  // translations go with it.
  for (const poly of findPolymorphicRefs(collections)) {
    const table = sql.identifier(poly.physicalTable);
    const coll = sql.identifier(poly.collectionColumn);
    const rowId = sql.identifier(poly.rowIdColumn);
    const scope = poly.tenantScoped
      ? sql` AND ${sql.identifier("tenant_id")} = ${tenantId}`
      : sql``;
    await run(
      sql`DELETE FROM ${table} WHERE ${coll} = ${targetSlug} AND ${rowId} = ${deletedId}${scope}`,
    );
    touched.add(poly.slug);
  }
  return touched;
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
  touched: Set<string>,
): Promise<void> => {
  if (victimIds.length === 0) return;
  const cRow = await loadCollection(ctx, tenantId, ref.slug).catch(() => null);
  for (const vid of victimIds) {
    if (cRow) {
      await deleteVector(ctx, cRow, tenantId, vid).catch(() => {});
      await deleteFts(ctx, cRow, vid).catch(() => {});
    }
    // Chain: the cascaded row may itself be referenced by other collections.
    await enforceOnDeleteTriggers(ctx, tenantId, ref.slug, vid, run, visited, touched);
  }
};
