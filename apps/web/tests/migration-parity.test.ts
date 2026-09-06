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

/**
 * Referential ACTIONS, declared vs. migrated — the fourth kind of drift.
 *
 * The three comparisons above match tables, columns and index NAMES, and all
 * three passed while `files.folder_id` carried `ON DELETE SET NULL` on Postgres
 * and a bare `REFERENCES folders(id)` on SQLite — with both `schema.ts` files
 * declaring `onDelete: "set null"`. Same table, same column, same index: no
 * shape difference to see.
 *
 * What that costs is a dialect-dependent answer to one question. Delete a folder
 * outside `DELETE /api/folders/:id` and on Postgres the files detach; on SQLite
 * with FK enforcement ON (which the CLI migrator sets) the delete raises
 * `FOREIGN KEY constraint failed`, and with it OFF (bun:sqlite's default, which
 * is what the auto-migrate boot path runs under) the files keep a `folder_id`
 * pointing at nothing and appear in neither the root listing nor any folder.
 *
 * Compared against what `schema.ts` DECLARES rather than across dialects,
 * deliberately: the cross-dialect block below only runs under
 * `BACKLEX_PG_TESTS=optional`, so a check placed there would be skipped in the
 * default suite and report success by matching nothing.
 */
describe("sqlite migrations honour the schema's referential actions", () => {
  /** `(table, column) -> on_delete` as the migrated database actually has it. */
  const migratedActions = (): Map<string, string> => {
    const out = new Map<string, string>();
    const names = (
      sqliteDb
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of names) {
      const fks = sqliteDb
        .query(`PRAGMA foreign_key_list("${t}")`)
        .all() as Array<{ from: string; on_delete: string }>;
      for (const fk of fks) {
        out.set(`${t}.${fk.from}`, (fk.on_delete ?? "NO ACTION").toUpperCase());
      }
    }
    return out;
  };

  /** `(table, column) -> on_delete` as `schema.ts` declares it. */
  const declaredActions = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const value of Object.values(sqliteSchemaNs.schema as Record<string, unknown>)) {
      if (!is(value as never, Table)) continue;
      const cfg = sqliteTableConfig(value as never);
      for (const fk of cfg.foreignKeys) {
        const ref = fk.reference();
        const action = (fk.onDelete ?? "no action").toUpperCase();
        for (const col of ref.columns) out.set(`${cfg.name}.${col.name}`, action);
      }
    }
    return out;
  };

  /**
   * The one divergence that is KNOWN, with why it is tolerated and what pays
   * for it.
   *
   * Not a place to put a new one. `20260504194131_rich_old_lace` created
   * `files.folder_id` with a bare `REFERENCES folders(id)` while the Postgres
   * twin and both `schema.ts` files say `ON DELETE SET NULL`. Correcting it on
   * SQLite means REBUILDING the table (SQLite cannot alter a constraint), and a
   * table rebuild is the exact migration class that caused the phase-8 incident
   * — a replay of one reset 26 collection metadata columns to their defaults.
   * On a pre-release audit the cheaper trade is to pin the divergence and let
   * the application compensate: `DELETE /api/folders/:id` detaches the files
   * itself, which is the only door that deletes a folder.
   *
   * The staleness test below is what stops this being a mute button: the day
   * the DDL is fixed, this entry matches nothing and the suite says so.
   */
  const KNOWN_ACTION_DRIFT = new Map<string, { declared: string; migrated: string }>([
    ["files.folder_id", { declared: "SET NULL", migrated: "NO ACTION" }],
  ]);

  /**
   * Every declared/migrated mismatch, optionally minus the recorded exceptions.
   *
   * The flag exists so the self-check below runs through THIS function rather
   * than a second loop of its own: a comparison that stopped comparing would
   * otherwise leave the drift list empty, every assertion would pass, and the
   * exception list would be doing all the work.
   */
  const driftEntries = (opts: { applyExceptions: boolean }): string[] => {
    const declared = declaredActions();
    const migrated = migratedActions();
    const out: string[] = [];
    for (const [key, action] of declared) {
      // Only judge FKs the migration actually created — a table that predates
      // the declaration is a different (and louder) failure the blocks above
      // already report.
      if (!migrated.has(key)) continue;
      const actual = migrated.get(key)!;
      if (actual === action) continue;
      if (opts.applyExceptions) {
        const known = KNOWN_ACTION_DRIFT.get(key);
        if (known && known.declared === action && known.migrated === actual) continue;
      }
      out.push(`${key}: schema.ts says ${action}, migrated db says ${actual}`);
    }
    return out;
  };

  test("every declared ON DELETE reaches the migrated database", () => {
    const drift = driftEntries({ applyExceptions: true });
    expect(
      drift.length === 0
        ? ""
        : "A migration created a foreign key without the referential action its\n" +
          "schema declares. Folder deletes, cascades and detaches then behave\n" +
          "differently per dialect, silently:\n  " +
          drift.join("\n  "),
    ).toBe("");
  });

  test("the comparison really finds the known divergence", () => {
    // Without this the exception list would be doing all the work: a comparison
    // that stopped comparing would leave `driftEntries()` empty and every
    // assertion above would still pass. Asserted on the RAW set — everything
    // that differs, before the exception filter — so it is the comparison
    // itself under test.
    const raw = driftEntries({ applyExceptions: false }).map((line) => line.split(":")[0]!);
    expect(raw.sort()).toEqual([...KNOWN_ACTION_DRIFT.keys()].sort());
  });

  test("no KNOWN_ACTION_DRIFT entry is stale", () => {
    // An excuse that matches nothing any more must go, or the next divergence
    // in that table inherits an exemption nobody wrote for it.
    const declared = declaredActions();
    const migrated = migratedActions();
    const stale: string[] = [];
    for (const [key, expected] of KNOWN_ACTION_DRIFT) {
      const d = declared.get(key);
      const m = migrated.get(key);
      if (d === expected.declared && m === expected.migrated) continue;
      stale.push(`${key} (recorded ${expected.declared}/${expected.migrated}, now ${d}/${m})`);
    }
    expect(
      stale.length === 0
        ? ""
        : `KNOWN_ACTION_DRIFT entries no longer describe reality — delete them:\n  ${stale.join("\n  ")}`,
    ).toBe("");
  });

  test("the guard sees the foreign keys it is supposed to be judging", () => {
    // A comparison that matches nothing reports success. Pin that there ARE
    // declared foreign keys and that they were found in the migrated database.
    const declared = declaredActions();
    const migrated = migratedActions();
    expect(declared.size).toBeGreaterThan(5);
    const overlap = [...declared.keys()].filter((k) => migrated.has(k));
    expect(overlap.length).toBeGreaterThan(5);
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
