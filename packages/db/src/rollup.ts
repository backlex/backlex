import { sql, type SQL } from "drizzle-orm";
import type { RollupFn } from "./field-types";

/**
 * The SQL half of rollup fields — one statement that restates a parent's
 * aggregate column from its children.
 *
 * Everything here is deliberately a SINGLE self-contained `UPDATE … SET col =
 * (SELECT …)`, never a read-then-write. Two reasons, and both are load-bearing:
 *
 *  - **Races.** Two children inserted concurrently under one parent would each
 *    read the same "before" total and write back the same wrong number. A
 *    subquery is evaluated by the database at execution time, so whichever
 *    statement runs second sees the first one's row. The total cannot drift
 *    apart from the rows it summarises, whatever the interleaving.
 *  - **Atomic batches.** `performCreate`/`performUpdate`/`performDelete` may run
 *    in "collect" mode, where write statements are queued and replayed inside
 *    one transaction rather than executed immediately. A refresh that needed to
 *    *read* would read a pre-write snapshot; a refresh that is one statement
 *    just joins the queue in order and computes against the committed children.
 *
 * @module
 */

/** How the child rows are reduced to the single number stored on the parent. */
const aggregateExpr = (fn: RollupFn, childTable: string, field?: string): SQL => {
  if (fn === "count") {
    // COUNT over an empty set is 0, and a scalar subquery containing an
    // aggregate always yields a row — no COALESCE needed.
    return sql`COUNT(*)`;
  }
  const col = sql`${sql.identifier(childTable)}.${sql.identifier(field as string)}`;
  switch (fn) {
    case "sum":
      // SUM over an empty set is NULL in both dialects; a total of nothing is 0.
      return sql`COALESCE(SUM(${col}), 0)`;
    case "avg":
      return sql`AVG(${col})`;
    case "min":
      return sql`MIN(${col})`;
    default:
      return sql`MAX(${col})`;
  }
};

export interface RollupRefreshInput {
  /** Physical table of the collection that OWNS the rollup column. */
  parentTable: string;
  /** Primary-key column on the parent table. */
  parentPk: string;
  /** The rollup column being restated. */
  column: string;
  /** Physical table holding the rows being aggregated. */
  childTable: string;
  /** Relation column on the child table pointing back at the parent's PK. */
  childFk: string;
  fn: RollupFn;
  /** Child column to aggregate — required for every fn but `count`. */
  field?: string;
  /**
   * Extra predicate over the CHILD rows: the compiled `rollup.filter` AND the
   * child's tenant / soft-delete scoping. Null means "every child row".
   */
  childWhere?: SQL | null;
  /**
   * Which parent rows to restate. A single id for the ordinary write-path
   * refresh, or a broader predicate (tenant-wide) for a backfill / repair.
   */
  parentWhere: SQL;
}

/**
 * `UPDATE <parent> SET <col> = (SELECT <agg> FROM <child> WHERE <child>.<fk> =
 * <parent>.<pk> [AND …]) WHERE <parentWhere>`.
 *
 * The correlated reference qualifies the parent by its full table name, which
 * both Postgres and SQLite resolve inside an UPDATE subquery. Identifiers all
 * arrive through `sql.identifier`, so a collection slug or field name can never
 * reach the statement as text.
 */
export const rollupRefreshSql = (i: RollupRefreshInput): SQL => {
  const correlate = sql`${sql.identifier(i.childTable)}.${sql.identifier(i.childFk)} = ${sql.identifier(i.parentTable)}.${sql.identifier(i.parentPk)}`;
  const where = i.childWhere ? sql`${correlate} AND (${i.childWhere})` : correlate;
  return sql`UPDATE ${sql.identifier(i.parentTable)} SET ${sql.identifier(i.column)} = (SELECT ${aggregateExpr(i.fn, i.childTable, i.field)} FROM ${sql.identifier(i.childTable)} WHERE ${where}) WHERE ${i.parentWhere}`;
};
