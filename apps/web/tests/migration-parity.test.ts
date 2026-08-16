/**
 * Migration ↔ schema ↔ cross-dialect parity guard.
 *
 * `schema-parity.test.ts` compares the two Drizzle schema FILES — it can't see
 * whether the hand-written migration SQL actually produces that schema. This
 * spec closes that gap by APPLYING every migration to a fresh database per
 * dialect and introspecting what really exists:
 *
 *   1. Statement hygiene — every `--> statement-breakpoint` chunk holds exactly
 *      one statement. Multi-statement chunks silently lose their tail on every
 *      prepared-statement runner (drizzle's native migrators, `auto-migrate.ts`
 *      on Neon/libsql): the 20260510 scheduled_tasks migration shipped this way
 *      and its two indexes never reached migrated databases.
 *   2. Migrated DB ↔ schema.ts, per dialect — tables, columns, and declared
 *      index names must all exist after migrations run ("edited schema.ts,
 *      forgot the migration" and the reverse).
 *   3. Migrated pg ↔ migrated sqlite — table/column/index parity between the
 *      two dialects' migration chains ("wrote one dialect's migration, forgot
 *      the other"), modulo the documented adapter divergences below.
 *
 * pglite boot can fail on some local setups (WASM extension unpack); like
 * pg-smoke.test.ts we skip the pg-dependent halves with a loud log rather than
 * fail — CI (linux) always runs them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { migrate as migrateSqlite } from "drizzle-orm/bun-sqlite/migrator";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as pgSchemaNs from "@backlex/db/pg";
import * as sqliteSchemaNs from "@backlex/db/sqlite";
import { PG_TESTS_OPTIONAL } from "./setup-pg";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const SQLITE_MIGRATIONS = resolve(ROOT, "packages/db/drizzle/sqlite");
const PG_MIGRATIONS = resolve(ROOT, "packages/db/drizzle/pg");

// ---------------------------------------------------------------------------
// Documented dialect divergences. Anything NOT listed here that differs
// between the two migrated databases is drift and fails the spec. Keep every
// entry justified — this list is the contract, not a dumping ground.
// ---------------------------------------------------------------------------

/** The sqlite migrator's own ledger table. */
const SQLITE_LEDGER_TABLES = new Set(["__drizzle_migrations"]);

/** The legacy single `embeddings` table (pre per-model split). Both dialects'
 *  early migrations created it; it was later removed from schema.ts but never
 *  dropped (migrations are additive-only), so migrated databases still carry
 *  it plus its indexes — and on pg its `embedding` vector column. */
const LEGACY_TABLES = new Set(["embeddings"]);
const LEGACY_INDEXES_BOTH = new Set([
  "embeddings_namespace_idx",
  "embeddings_ref_idx",
]);
const LEGACY_INDEXES_PG = new Set([
  ...LEGACY_INDEXES_BOTH,
  "embeddings_hnsw_idx",
]);
const LEGACY_COLUMNS_PG = new Set(["embeddings.embedding"]);

/** pg-only indexes vs sqlite: pgvector HNSW ANN indexes (sqlite brute-forces
 *  over f32 blobs, no ANN index exists), plus the UNIQUE(token_hash) table
 *  constraint's backing index — sqlite enforces the same uniqueness via the
 *  explicit `shared_links_token_idx` UNIQUE index (present in BOTH). */
const PG_ONLY_INDEXES_CROSS = new Set([
  "embeddings_hnsw_idx",
  "embeddings_openai_1536_hnsw_idx",
  "embeddings_self_host_bge_m3_hnsw_idx",
  "embeddings_bge_m3_hnsw_idx",
  "shared_links_token_hash_unique",
]);

// ---------------------------------------------------------------------------
// Introspection helpers
// ---------------------------------------------------------------------------

interface DbShape {
  /** physical table name → sorted column names */
  tables: Map<string, string[]>;
  /** explicitly-named index names (constraint/auto indexes filtered out) */
  indexes: Set<string>;
}

const migrationChunks = (root: string): Array<{ dir: string; chunk: string }> => {
  const out: Array<{ dir: string; chunk: string }> = [];
  for (const dir of readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const body = readFileSync(resolve(root, dir, "migration.sql"), "utf8");
    for (const chunk of body.split(/-->\s*statement-breakpoint\s*/i)) {
      if (chunk.trim()) out.push({ dir, chunk });
    }
  }
  return out;
};

/** Rough statement counter: strips `--` comments and single-quoted literals,
 *  then counts non-empty `;`-separated parts. Good enough for DDL migrations;
 *  revisit if a migration ever ships a trigger/DO body (none do today). */
const countStatements = (chunk: string): number =>
  chunk
    .replace(/--[^\n]*/g, "")
    .replace(/'(?:[^']|'')*'/g, "''")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean).length;

const introspectSqlite = (db: Database): DbShape => {
  const tables = new Map<string, string[]>();
  const names = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  for (const t of names) {
    const cols = (
      db.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]
    )
      .map((c) => c.name)
      .sort();
    tables.set(t, cols);
  }
  const indexes = new Set(
    (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
  return { tables, indexes };
};

const introspectPg = async (pg: PGlite): Promise<DbShape> => {
  const tables = new Map<string, string[]>();
  const tRows = (
    await pg.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
    )
  ).rows as { table_name: string }[];
  for (const r of tRows) tables.set(r.table_name, []);
  const cRows = (
    await pg.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'",
    )
  ).rows as { table_name: string; column_name: string }[];
  for (const r of cRows) tables.get(r.table_name)?.push(r.column_name);
  for (const [k, v] of tables) tables.set(k, v.sort());
  const iRows = (
    await pg.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public'",
    )
  ).rows as { indexname: string }[];
  const indexes = new Set(
    iRows.map((r) => r.indexname).filter((n) => !n.endsWith("_pkey")),
  );
  return { tables, indexes };
};

/** Pull physical-name → columns + declared index names out of a Drizzle
 *  schema namespace. */
const schemaShape = (
  ns: Record<string, unknown>,
  tableConfig: (t: never) => { indexes?: Array<{ config?: { name?: string }; name?: string }> },
): DbShape => {
  const tables = new Map<string, string[]>();
  const indexes = new Set<string>();
  for (const val of Object.values(ns)) {
    if (!is(val, Table)) continue;
    tables.set(
      getTableName(val),
      Object.values(getTableColumns(val))
        .map((c) => (c as { name: string }).name)
        .sort(),
    );
    for (const idx of tableConfig(val as never).indexes ?? []) {
      const name = idx.config?.name ?? idx.name;
      if (name) indexes.add(name);
    }
  }
  return { tables, indexes };
};

const diffShapes = (
  a: DbShape,
  aLabel: string,
  b: DbShape,
  bLabel: string,
  opts: {
    onlyA?: Set<string>;
    onlyB?: Set<string>;
    colOnlyB?: Set<string>;
    idxOnlyA?: Set<string>;
    idxOnlyB?: Set<string>;
  } = {},
): string[] => {
  const problems: string[] = [];
  for (const t of a.tables.keys()) {
    if (!b.tables.has(t) && !opts.onlyA?.has(t))
      problems.push(`table "${t}" exists in ${aLabel} but not ${bLabel}`);
  }
  for (const t of b.tables.keys()) {
    if (!a.tables.has(t) && !opts.onlyB?.has(t))
      problems.push(`table "${t}" exists in ${bLabel} but not ${aLabel}`);
  }
  for (const [t, aCols] of a.tables) {
    const bCols = b.tables.get(t);
    if (!bCols) continue;
    for (const c of aCols) {
      if (!bCols.includes(c))
        problems.push(`column "${t}.${c}" exists in ${aLabel} but not ${bLabel}`);
    }
    for (const c of bCols) {
      if (!aCols.includes(c) && !opts.colOnlyB?.has(`${t}.${c}`))
        problems.push(`column "${t}.${c}" exists in ${bLabel} but not ${aLabel}`);
    }
  }
  for (const i of a.indexes) {
    if (!b.indexes.has(i) && !opts.idxOnlyA?.has(i))
      problems.push(`index "${i}" exists in ${aLabel} but not ${bLabel}`);
  }
  for (const i of b.indexes) {
    if (!a.indexes.has(i) && !opts.idxOnlyB?.has(i))
      problems.push(`index "${i}" exists in ${bLabel} but not ${aLabel}`);
  }
  return problems;
};

// ---------------------------------------------------------------------------
// 1. Statement hygiene — cheap, no DB needed, both dialects.
// ---------------------------------------------------------------------------

describe("migration statement hygiene", () => {
  for (const [dialect, root] of [
    ["sqlite", SQLITE_MIGRATIONS],
    ["pg", PG_MIGRATIONS],
  ] as const) {
    test(`every ${dialect} breakpoint chunk holds exactly one statement`, () => {
      const offenders = migrationChunks(root)
        .filter(({ chunk }) => countStatements(chunk) > 1)
        .map(
          ({ dir, chunk }) =>
            `${dialect}/${dir}: ${chunk.trim().slice(0, 80).replace(/\s+/g, " ")}…`,
        );
      expect(offenders).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 2 + 3. Apply migrations for real and compare.
// ---------------------------------------------------------------------------

const sqliteDb = new Database(":memory:");
migrateSqlite(drizzleSqlite({ client: sqliteDb }), {
  migrationsFolder: SQLITE_MIGRATIONS,
});
const migratedSqlite = introspectSqlite(sqliteDb);
const declaredSqlite = schemaShape(
  sqliteSchemaNs.schema as unknown as Record<string, unknown>,
  sqliteTableConfig as never,
);

let pgInstance: PGlite | null = null;
let migratedPg: DbShape | null = null;
try {
  // Raw `pg.exec` (simple protocol) — the extended protocol races the vector
  // extension load; see setup-pg.ts for the full story.
  pgInstance = new PGlite({ extensions: { vector } });
  await pgInstance.waitReady;
  await pgInstance.exec("CREATE EXTENSION IF NOT EXISTS vector");
  for (const dir of readdirSync(PG_MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const body = readFileSync(resolve(PG_MIGRATIONS, dir, "migration.sql"), "utf8");
    for (const stmt of body
      .split(/-->\s*statement-breakpoint\s*/i)
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pgInstance.exec(stmt);
    }
  }
  migratedPg = await introspectPg(pgInstance);
} catch (err) {
  try {
    await pgInstance?.close();
  } catch {
    // already closing
  }
  // A pglite that cannot boot is a defect, not a missing environment — it ships
  // the server and pgvector inside the dependency tree. Skipping here left the
  // pg half of migration parity asserting nothing while the file still reported
  // green, which is the same shape `pg-specs-fail-loudly.test.ts` exists to
  // forbid. Escape hatch is opt-in and says what it costs.
  if (!PG_TESTS_OPTIONAL) {
    throw new Error(
      `[migration-parity] pglite setup failed, so the pg migrations were never compared against pg/schema.ts. ` +
        `Fix the cause, or re-run with BACKLEX_PG_TESTS=optional. Cause: ${(err as Error).message}`,
      { cause: err },
    );
  }
  console.warn(
    `[migration-parity] BACKLEX_PG_TESTS=optional — the pg-side checks asserted NOTHING: ${
      (err as Error).message
    }`,
  );
  pgInstance = null;
}

afterAll(async () => {
  sqliteDb.close();
  try {
    await pgInstance?.close();
  } catch {
    // already closed
  }
});

describe("sqlite migrations ↔ sqlite schema.ts", () => {
  test("migrated database matches the declared schema", () => {
    expect(
      diffShapes(declaredSqlite, "schema.ts", migratedSqlite, "migrated db", {
        onlyB: new Set([...SQLITE_LEDGER_TABLES, ...LEGACY_TABLES]),
        idxOnlyB: LEGACY_INDEXES_BOTH,
      }),
    ).toEqual([]);
  });
});

describe("pg migrations ↔ pg schema.ts", () => {
  test("migrated database matches the declared schema", () => {
    // Only reachable under `BACKLEX_PG_TESTS=optional`.
    if (!migratedPg) return;
    const declaredPg = schemaShape(
      pgSchemaNs.schema as unknown as Record<string, unknown>,
      pgTableConfig as never,
    );
    expect(
      diffShapes(declaredPg, "schema.ts", migratedPg, "migrated db", {
        onlyB: LEGACY_TABLES,
        // The UNIQUE(token_hash) constraint index comes from the migration's
        // table constraint, not a schema.ts `index()` declaration.
        idxOnlyB: new Set([...LEGACY_INDEXES_PG, "shared_links_token_hash_unique"]),
      }),
    ).toEqual([]);
  });
});

describe("migrated pg ↔ migrated sqlite", () => {
  test("both migration chains produce the same structure", () => {
    // Only reachable under `BACKLEX_PG_TESTS=optional`.
    if (!migratedPg) return;
    expect(
      diffShapes(migratedSqlite, "sqlite", migratedPg, "pg", {
        onlyA: SQLITE_LEDGER_TABLES,
        colOnlyB: LEGACY_COLUMNS_PG,
        idxOnlyB: PG_ONLY_INDEXES_CROSS,
      }),
    ).toEqual([]);
  });
});
