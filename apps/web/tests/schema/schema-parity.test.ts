/**
 * Dual-dialect schema drift guard. System tables live in BOTH
 * `packages/db/src/pg/schema.ts` and `.../sqlite/schema.ts`, which must stay in
 * lockstep — every table and column present in one dialect must exist in the
 * other. Because nearly every query site casts `(ctx.db as any)` (the Pg/Sqlite
 * Drizzle union has no common typed surface), a column that drifts between the
 * two files is NOT caught by `tsc`; it only surfaces as a runtime 500 on the
 * dialect that's missing it.
 *
 * This test compares the two schemas structurally so drift fails CI instead.
 * It's the low-risk substitute for retyping all ~476 `as any` sites: it catches
 * the exact class of bug those casts hide, at zero call-site churn.
 */
import { describe, expect, test } from "bun:test";
import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";

interface TableInfo {
  physical: string;
  columns: string[];
}

const collect = (schema: Record<string, unknown>): Map<string, TableInfo> => {
  const out = new Map<string, TableInfo>();
  for (const [varName, val] of Object.entries(schema)) {
    if (is(val, Table)) {
      out.set(varName, {
        physical: getTableName(val),
        columns: Object.keys(getTableColumns(val)).sort(),
      });
    }
  }
  return out;
};

const pgTables = collect(pg.schema as unknown as Record<string, unknown>);
const sqliteTables = collect(sqlite.schema as unknown as Record<string, unknown>);

describe("pg ↔ sqlite schema parity", () => {
  test("both dialects export the same set of tables (by var name)", () => {
    const pgNames = [...pgTables.keys()].sort();
    const sqliteNames = [...sqliteTables.keys()].sort();
    expect(sqliteNames).toEqual(pgNames);
    // Sanity: the parser actually found the schema (not an empty namespace).
    expect(pgNames.length).toBeGreaterThan(40);
  });

  test("each table maps to the same physical DB name in both dialects", () => {
    const mismatches: string[] = [];
    for (const [varName, pgInfo] of pgTables) {
      const sq = sqliteTables.get(varName);
      if (sq && sq.physical !== pgInfo.physical) {
        mismatches.push(`${varName}: pg=${pgInfo.physical} sqlite=${sq.physical}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("each table has the same column set in both dialects", () => {
    const drift: string[] = [];
    for (const [varName, pgInfo] of pgTables) {
      const sq = sqliteTables.get(varName);
      if (!sq) continue; // covered by the table-set test above
      const pgCols = new Set(pgInfo.columns);
      const sqCols = new Set(sq.columns);
      const onlyPg = pgInfo.columns.filter((c) => !sqCols.has(c));
      const onlySqlite = sq.columns.filter((c) => !pgCols.has(c));
      if (onlyPg.length || onlySqlite.length) {
        drift.push(
          `${varName} (${pgInfo.physical}): pg-only=[${onlyPg.join(",")}] sqlite-only=[${onlySqlite.join(",")}]`,
        );
      }
    }
    expect(drift).toEqual([]);
  });
});
