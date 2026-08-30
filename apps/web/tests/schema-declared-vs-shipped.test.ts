/**
 * Declared schema ↔ SHIPPED migrations.
 *
 * System tables are DECLARED in `packages/db/src/{pg,sqlite}/schema.ts` and
 * CREATED by hand-written SQL under `packages/db/drizzle/{pg,sqlite}/`.
 * `db:generate:*` only refreshes a drizzle snapshot; it never writes the
 * migration. So a column can be declared, used by route code, type-check
 * clean, pass every spec that runs against a freshly-migrated database — and
 * be absent in production, because nobody wrote the ALTER.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `migration-parity.test.ts`
 * --------------------------------------------------------
 * `migration-parity.test.ts` already applies the migration DIRECTORY to a real
 * database and diffs it against schema.ts. That is the stronger check of the
 * two and this file does not duplicate it. What it does not cover is WHICH
 * BYTES SHIP:
 *
 *   * Production never reads the directory. Vercel, Netlify and the Worker all
 *     boot through `packages/db/src/auto-migrate.ts`, which applies
 *     `packages/db/src/{pg,sqlite}/migrations-bundle.ts` — a GENERATED module
 *     that text-imports every `migration.sql` so the SQL is inlined at build
 *     time. Both test harnesses (`tests/setup.ts`, `tests/setup-pg.ts`) and
 *     `migration-parity.test.ts` read the DIRECTORY instead. Nothing in
 *     `bun test` has ever compared the two.
 *   * The only thing holding the bundle to the directory is a lefthook
 *     pre-commit job (`migration-bundles-in-sync`) whose glob matches only
 *     `migration.sql` files under `packages/db/drizzle`. That glob does not
 *     fire when the generated bundle is hand-edited, does not fire when
 *     `scripts/gen-migration-bundles.ts` itself changes, and does not run at
 *     all under `--no-verify` or for a branch merged through the GitHub UI.
 *     lefthook.yml says this out loud for its sibling job: "This hook is the
 *     fast feedback, NOT the guarantee. The guarantee is
 *     `apps/web/tests/consent-banner.test.ts`". The migration bundles had no
 *     such guarantee. This file is it.
 *
 * WHAT IT CHECKS
 *   1. The bundle IS the directory — same migration names, same order, byte
 *      identical SQL, both dialects.
 *   2. Declared columns ↔ columns the BUNDLE'S SQL actually creates or adds,
 *      both directions, both dialects. A column in the migrations but not the
 *      schema counts too: that is a column the ORM cannot see.
 *   3. `migrations-manifest.generated.ts` (sha256 → folder tag, powering the
 *      admin Migrations page) names every shipped migration. Cosmetic
 *      severity — a stale entry renders `tag: null` — but it is a third
 *      generated artifact with no hook and no test.
 *
 * HOW THE SQL IS READ, AND WHY THAT IS TRUSTWORTHY
 * TypeScript 7.0 ships no compiler API, but nothing here needs one: the
 * migrations are plain SQL text and this is a SOURCE SCAN over that text — a
 * small DDL interpreter that replays CREATE TABLE / ALTER TABLE ADD|DROP|RENAME
 * COLUMN / DROP TABLE / ALTER TABLE RENAME TO in bundle order.
 *
 * A source scan is only worth having if it cannot pass by matching nothing, so:
 *
 *   * Every statement whose first word is CREATE/ALTER/DROP TABLE must be
 *     RECOGNISED. An unparsed shape lands in `unrecognised` and FAILS the spec
 *     rather than being silently skipped.
 *   * The scanner is pinned against ground truth: the same bundle is executed
 *     into an in-memory `bun:sqlite` database and the scanner's table→column
 *     map must equal `PRAGMA table_info` EXACTLY, in both directions. If the
 *     scanner ever stops understanding this repo's DDL, that test goes red
 *     before the comparison it feeds can go quietly green. The pg half runs
 *     the same scanner over the same statement style (only the quoting and
 *     `IF NOT EXISTS` differ), and a scanner that under- or over-collects
 *     there surfaces as a diff, not as a pass.
 *   * Non-vacuity floors on every count: migrations, tables, columns, and each
 *     statement kind must all be non-trivially large.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import { MIGRATION_TAGS_PG, MIGRATION_TAGS_SQLITE } from "@backlex/db";
import * as pgSchemaNs from "@backlex/db/pg";
import * as sqliteSchemaNs from "@backlex/db/sqlite";
import { MIGRATIONS as PG_BUNDLE } from "@backlex/db/pg/migrations-bundle";
import { MIGRATIONS as SQLITE_BUNDLE } from "@backlex/db/sqlite/migrations-bundle";

const ROOT = resolve(import.meta.dir, "..", "..", "..");

interface BundledMigration {
  name: string;
  sql: string;
}

type Dialect = "pg" | "sqlite";

// ---------------------------------------------------------------------------
// Documented divergences. Anything NOT listed here that differs is drift and
// fails the spec. Every entry is asserted to still be REACHED (see
// "allowlist entries are all still live") so a stale exemption cannot quietly
// widen the guard.
// ---------------------------------------------------------------------------

/**
 * The legacy single `embeddings` table, superseded by the per-model split.
 * Both dialects' early migrations created it; it was dropped from schema.ts
 * but never dropped from the database, because these migrations run on the
 * boot path and are additive-only. `migration-parity.test.ts` carries the same
 * exemption for the same reason.
 */
const LEGACY_SHIPPED_ONLY_TABLES: Record<Dialect, readonly string[]> = {
  pg: ["embeddings"],
  sqlite: ["embeddings"],
};

// ---------------------------------------------------------------------------
// SQL source scanner
// ---------------------------------------------------------------------------

/** SQL identifier: double-quoted (pg), backticked (sqlite), or bare. */
const ID = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';

/** Leading words that make a CREATE TABLE body part a table CONSTRAINT rather
 *  than a column. Only honoured for an UNQUOTED token — `` `check` `` is a
 *  perfectly legal column name. */
const CONSTRAINT_LEAD = new Set([
  "constraint",
  "primary",
  "foreign",
  "unique",
  "check",
  "exclude",
  "like",
]);

const unquote = (s: string): string => s.replace(/^["`[]/, "").replace(/["`\]]$/, "");

/** Strip `--` line comments and C-style block comments without touching quoted
 *  text. Naive stripping would eat the apostrophe-bearing prose these
 *  migrations are full of, and would also eat a `--` inside a string literal. */
const stripComments = (sql: string): string => {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (quote) {
      out += c;
      if (c === quote) {
        if (c === "'" && sql[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

/** Split a CREATE TABLE body on commas that are not inside parens or quotes. */
const splitTopLevel = (body: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
};

interface FirstToken {
  name: string;
  quoted: boolean;
}

const firstToken = (s: string): FirstToken | null => {
  const m = s.trim().match(new RegExp(`^(${ID})`));
  if (!m) return null;
  const raw = m[1] as string;
  return { name: unquote(raw), quoted: /^["`[]/.test(raw) };
};

const isConstraintPart = (t: FirstToken): boolean =>
  !t.quoted && CONSTRAINT_LEAD.has(t.name.toLowerCase());

interface ScanResult {
  /** physical table name → column names */
  tables: Map<string, Set<string>>;
  /** `table.column` → the migration that introduced it */
  origin: Map<string, string>;
  /** DDL this scanner did not understand — must always be empty */
  unrecognised: string[];
  counts: { createTable: number; addColumn: number; dropTable: number; renameTable: number };
}

/**
 * Replay the DDL of a migration bundle and return the table/column shape it
 * leaves behind. Only statements that change the set of tables or columns are
 * interpreted; CREATE INDEX, INSERT/UPDATE/DELETE, CREATE EXTENSION and the
 * like are irrelevant here and skipped by the first-word filter.
 */
const scanBundle = (migrations: readonly BundledMigration[]): ScanResult => {
  const tables = new Map<string, Set<string>>();
  const origin = new Map<string, string>();
  const unrecognised: string[] = [];
  const counts = { createTable: 0, addColumn: 0, dropTable: 0, renameTable: 0 };

  for (const migration of migrations) {
    // `--> statement-breakpoint` separates statements; the trailing `;` split
    // catches the handful of chunks that carry more than one (see the
    // statement-hygiene test in migration-parity.test.ts).
    for (const chunk of migration.sql.split(/-->\s*statement-breakpoint/i)) {
      for (const piece of stripComments(chunk).split(";")) {
        const st = piece.trim().replace(/\s+/g, " ");
        if (!st) continue;
        const lower = st.toLowerCase();
        if (
          !lower.startsWith("create table") &&
          !lower.startsWith("alter table") &&
          !lower.startsWith("drop table")
        )
          continue;

        // CREATE TABLE [IF NOT EXISTS] t ( ... )
        const create = st.match(
          new RegExp(`^create table (if not exists )?(${ID}) ?\\(([\\s\\S]*)\\)$`, "i"),
        );
        if (create) {
          const ifNotExists = Boolean(create[1]);
          const table = unquote(create[2] as string);
          if (ifNotExists && tables.has(table)) continue; // real no-op
          const cols = new Set<string>();
          for (const part of splitTopLevel(create[3] as string)) {
            const tok = firstToken(part);
            if (!tok || isConstraintPart(tok)) continue;
            cols.add(tok.name);
            origin.set(`${table}.${tok.name}`, migration.name);
          }
          tables.set(table, cols);
          counts.createTable++;
          continue;
        }

        // ALTER TABLE [ONLY] t ADD [COLUMN] [IF NOT EXISTS] c ...
        // (also matches ADD CONSTRAINT / ADD PRIMARY KEY / ADD UNIQUE, which
        //  the constraint filter below drops.)
        const add = st.match(new RegExp(`^alter table (?:only )?(${ID}) add (.*)$`, "i"));
        if (add) {
          const table = unquote(add[1] as string);
          const rest = (add[2] as string)
            .replace(/^column /i, "")
            .replace(/^if not exists /i, "");
          const tok = firstToken(rest);
          if (!tok || isConstraintPart(tok)) continue;
          const cols = tables.get(table);
          if (!cols) {
            unrecognised.push(`${migration.name}: ADD COLUMN on unknown table "${table}"`);
            continue;
          }
          cols.add(tok.name);
          origin.set(`${table}.${tok.name}`, migration.name);
          counts.addColumn++;
          continue;
        }

        // ALTER TABLE t DROP COLUMN [IF EXISTS] c
        const drop = st.match(
          new RegExp(`^alter table (?:only )?(${ID}) drop column (?:if exists )?(${ID})`, "i"),
        );
        if (drop) {
          tables.get(unquote(drop[1] as string))?.delete(unquote(drop[2] as string));
          continue;
        }

        // ALTER TABLE t RENAME COLUMN a TO b
        const renameCol = st.match(
          new RegExp(`^alter table (?:only )?(${ID}) rename column (${ID}) to (${ID})$`, "i"),
        );
        if (renameCol) {
          const cols = tables.get(unquote(renameCol[1] as string));
          if (cols) {
            cols.delete(unquote(renameCol[2] as string));
            cols.add(unquote(renameCol[3] as string));
          }
          continue;
        }

        // ALTER TABLE t RENAME TO t2 — the tail of sqlite's table-rebuild dance.
        const renameTable = st.match(new RegExp(`^alter table (${ID}) rename to (${ID})$`, "i"));
        if (renameTable) {
          const from = unquote(renameTable[1] as string);
          const to = unquote(renameTable[2] as string);
          const cols = tables.get(from);
          if (cols) {
            tables.delete(from);
            tables.set(to, cols);
            counts.renameTable++;
          }
          continue;
        }

        // DROP TABLE [IF EXISTS] t
        const dropTable = st.match(new RegExp(`^drop table (?:if exists )?(${ID})`, "i"));
        if (dropTable) {
          if (tables.delete(unquote(dropTable[1] as string))) counts.dropTable++;
          continue;
        }

        // Shapes that change neither tables nor columns.
        if (
          /^alter table .* (alter column|drop constraint|drop primary key|enable |disable |set |owner to|validate constraint)/i.test(
            st,
          )
        )
          continue;

        unrecognised.push(`${migration.name}: ${st.slice(0, 120)}`);
      }
    }
  }
  return { tables, origin, unrecognised, counts };
};

// ---------------------------------------------------------------------------
// Declared schema
// ---------------------------------------------------------------------------

/** physical table name → declared column names, straight off the Drizzle
 *  table objects (so a renamed `.name` is read, not the TS property). */
const declaredShape = (ns: Record<string, unknown>): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const value of Object.values(ns)) {
    if (!is(value, Table)) continue;
    out.set(
      getTableName(value),
      Object.values(getTableColumns(value))
        .map((c) => (c as { name: string }).name)
        .sort(),
    );
  }
  return out;
};

const DIALECTS: ReadonlyArray<{
  dialect: Dialect;
  bundle: readonly BundledMigration[];
  declared: Map<string, string[]>;
  tags: Record<string, string>;
}> = [
  {
    dialect: "pg",
    bundle: PG_BUNDLE,
    declared: declaredShape(pgSchemaNs.schema as unknown as Record<string, unknown>),
    tags: MIGRATION_TAGS_PG,
  },
  {
    dialect: "sqlite",
    bundle: SQLITE_BUNDLE,
    declared: declaredShape(sqliteSchemaNs.schema as unknown as Record<string, unknown>),
    tags: MIGRATION_TAGS_SQLITE,
  },
];

const scans = new Map<Dialect, ScanResult>(
  DIALECTS.map(({ dialect, bundle }) => [dialect, scanBundle(bundle)]),
);

const scanOf = (dialect: Dialect): ScanResult => {
  const s = scans.get(dialect);
  if (!s) throw new Error(`no scan for ${dialect}`);
  return s;
};

// ---------------------------------------------------------------------------
// 1. The bundle IS the directory.
// ---------------------------------------------------------------------------

describe("shipped migration bundle ↔ migration directory", () => {
  for (const { dialect, bundle } of DIALECTS) {
    test(`${dialect}: the bundle lists every migration directory, in order`, () => {
      const root = resolve(ROOT, "packages/db/drizzle", dialect);
      const onDisk = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, "migration.sql")))
        .map((d) => d.name)
        .sort();

      // Non-vacuity: if the directory read ever returns nothing this must fail,
      // not pass with two empty lists.
      expect(onDisk.length).toBeGreaterThan(120);
      expect(bundle.map((m) => m.name)).toEqual(onDisk);
    });

    // NOTE ON WHAT THIS PROVES. Under `bun test` the bundle's
    // `import ... with { type: "text" }` reads the file live, so this cannot
    // catch an edit made to a migration.sql on its own. What it DOES catch is
    // the pairing going wrong inside the generated module — an entry whose
    // `name` no longer belongs to the file its `sql` was imported from, which
    // is the shape a hand-edit or a half-run generator leaves behind and which
    // would make production apply the wrong SQL under a recorded name.
    test(`${dialect}: every bundled migration carries the file's exact SQL`, () => {
      const root = resolve(ROOT, "packages/db/drizzle", dialect);
      const drift: string[] = [];
      let compared = 0;
      for (const migration of bundle) {
        const file = resolve(root, migration.name, "migration.sql");
        if (!existsSync(file)) {
          drift.push(`${migration.name}: bundled but the directory has no migration.sql`);
          continue;
        }
        compared++;
        const onDisk = readFileSync(file, "utf8");
        if (onDisk !== migration.sql) {
          drift.push(
            `${migration.name}: bundled SQL differs from the file ` +
              `(bundle ${migration.sql.length} bytes, file ${onDisk.length} bytes). ` +
              `Run \`bun scripts/gen-migration-bundles.ts\`.`,
          );
        }
      }
      expect(drift).toEqual([]);
      expect(compared).toBe(bundle.length);
      expect(compared).toBeGreaterThan(120);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Declared columns ↔ shipped columns.
// ---------------------------------------------------------------------------

describe("the SQL scanner understands every shipped statement", () => {
  for (const { dialect, bundle } of DIALECTS) {
    test(`${dialect}: no unrecognised CREATE/ALTER/DROP TABLE statement`, () => {
      const scan = scanOf(dialect);
      // An unparsed statement would silently drop a table or column from the
      // comparison below, which is the exact way a source scan turns into a
      // guard that passes by matching nothing.
      expect(scan.unrecognised).toEqual([]);
      expect(bundle.length).toBeGreaterThan(120);
      expect(scan.counts.createTable).toBeGreaterThan(100);
      expect(scan.counts.addColumn).toBeGreaterThan(100);
      expect(scan.tables.size).toBeGreaterThan(100);
      expect([...scan.tables.values()].reduce((n, c) => n + c.size, 0)).toBeGreaterThan(800);
    });
  }

  test("sqlite: the scanner's output equals a really-migrated database", () => {
    // Ground truth. Execute the SAME bundle the scanner read and introspect it.
    // This is what makes the pg scan believable: one scanner, one statement
    // style, proven exact on the dialect that can be executed for free.
    const db = new Database(":memory:");
    try {
      for (const migration of SQLITE_BUNDLE) {
        for (const chunk of migration.sql.split(/-->\s*statement-breakpoint/i)) {
          const st = chunk.trim();
          if (st) db.exec(st);
        }
      }
      const real = new Map<string, string[]>();
      for (const row of db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>) {
        real.set(
          row.name,
          (db.query(`PRAGMA table_info("${row.name}")`).all() as Array<{ name: string }>)
            .map((c) => c.name)
            .sort(),
        );
      }

      const scan = scanOf("sqlite");
      const diffs: string[] = [];
      for (const [table, cols] of real) {
        const scanned = scan.tables.get(table);
        if (!scanned) {
          diffs.push(`scanner missed table "${table}"`);
          continue;
        }
        for (const c of cols) if (!scanned.has(c)) diffs.push(`scanner missed "${table}.${c}"`);
        for (const c of scanned)
          if (!cols.includes(c)) diffs.push(`scanner invented "${table}.${c}"`);
      }
      for (const table of scan.tables.keys())
        if (!real.has(table)) diffs.push(`scanner invented table "${table}"`);

      expect(diffs).toEqual([]);
      expect(real.size).toBeGreaterThan(100);
    } finally {
      db.close();
    }
  });
});

describe("declared schema ↔ shipped migrations", () => {
  for (const { dialect, declared } of DIALECTS) {
    test(`${dialect}: every declared table and column is created by a migration`, () => {
      const scan = scanOf(dialect);
      const missing: string[] = [];
      for (const [table, cols] of declared) {
        const shipped = scan.tables.get(table);
        if (!shipped) {
          missing.push(
            `table "${table}" is declared in ${dialect}/schema.ts but no migration creates it`,
          );
          continue;
        }
        for (const col of cols) {
          if (!shipped.has(col))
            missing.push(
              `column "${table}.${col}" is declared in ${dialect}/schema.ts but no migration ` +
                `creates or adds it — write the ALTER under packages/db/drizzle/${dialect}/`,
            );
        }
      }
      expect(missing).toEqual([]);
      // Non-vacuity: the declared side must actually have been read.
      expect(declared.size).toBeGreaterThan(100);
    });

    test(`${dialect}: every shipped table and column is declared in schema.ts`, () => {
      const scan = scanOf(dialect);
      const allowed = new Set(LEGACY_SHIPPED_ONLY_TABLES[dialect]);
      const orphans: string[] = [];
      for (const [table, cols] of scan.tables) {
        if (allowed.has(table)) continue;
        const declaredCols = declared.get(table);
        if (!declaredCols) {
          orphans.push(
            `table "${table}" is created by a migration but absent from ${dialect}/schema.ts — ` +
              `the ORM cannot see it`,
          );
          continue;
        }
        for (const col of cols) {
          if (!declaredCols.includes(col))
            orphans.push(
              `column "${table}.${col}" is created by ` +
                `${scan.origin.get(`${table}.${col}`) ?? "a migration"} but absent from ` +
                `${dialect}/schema.ts — the ORM cannot see it`,
            );
        }
      }
      expect(orphans).toEqual([]);
    });

    test(`${dialect}: allowlisted shipped-only tables are all still live`, () => {
      // A stale exemption silently widens the guard. If one of these tables is
      // finally dropped, delete its entry instead of leaving it here.
      const scan = scanOf(dialect);
      const dead = LEGACY_SHIPPED_ONLY_TABLES[dialect].filter((t) => !scan.tables.has(t));
      expect(dead).toEqual([]);
      expect(LEGACY_SHIPPED_ONLY_TABLES[dialect].length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The hash → tag manifest covers what ships.
// ---------------------------------------------------------------------------

describe("migrations manifest ↔ shipped migrations", () => {
  for (const { dialect, bundle, tags } of DIALECTS) {
    test(`${dialect}: every shipped migration's sha256 resolves to its folder tag`, () => {
      // `migrations-manifest.generated.ts` is generated by
      // packages/db/scripts/build-manifest.ts, has NO lefthook job and had no
      // test. Staleness is cosmetic — the admin Migrations page renders
      // `tag: null` for the unmapped hash — but it is the same generated-file
      // drift shape as the bundle, so it is checked in the same place.
      const wrong: string[] = [];
      for (const migration of bundle) {
        const hash = createHash("sha256").update(migration.sql).digest("hex");
        const tag = tags[hash];
        if (tag === undefined) {
          wrong.push(
            `${migration.name}: sha256 ${hash.slice(0, 12)}… is not in the manifest — ` +
              `run \`bun run --cwd packages/db manifest\``,
          );
        } else if (tag !== migration.name) {
          wrong.push(`${migration.name}: manifest maps its hash to "${tag}"`);
        }
      }
      expect(wrong).toEqual([]);
      expect(Object.keys(tags).length).toBeGreaterThanOrEqual(bundle.length);
    });
  }
});
