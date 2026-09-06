/**
 * Phase 8 of the 2026-09 pre-production audit — the boot migration runner
 * replayed a bundle into a database that was already current, and the replay
 * silently reset collection metadata.
 *
 * THE DEFECT, as reproduced against a real SQLite file
 *
 * `bun run db:migrate:sqlite` — the documented self-host path — applies all 138
 * files and records their sha256 in `__drizzle_migrations`. The first request
 * then reaches `context.ts`, which calls `ensureMigrations` on every target
 * that is not D1; that runner keeps its OWN ledger, `__backlex_migrations`,
 * keyed by NAME. Two ledgers with nothing in common, so the second one is empty
 * and the whole bundle replays: `applied: 138, failed: 0`.
 *
 * The damage is in `20260510120000_per_workspace_collections`. SQLite cannot
 * ALTER a primary key, so the file rebuilds the table — create
 * `__new_collections` with the 14 columns of that era, copy, `DROP TABLE
 * collections`, rename. On a replay its FIRST statement (`ADD COLUMN id`)
 * raises `duplicate column name`, which the runner tolerated per-statement and
 * then ran the rebuild anyway, against a table that by then had 40 columns. The
 * other 26 are dropped with the old table and re-created at their DEFAULTS by
 * the later migrations replaying behind it. Nothing errors. A collection that
 * WRAPPED an existing table (`adopted = 1`) comes back as `adopted = 0`, i.e.
 * backlex now believes it owns a table the operator merely pointed at.
 *
 * WHY THE FINDING'S OWN FIX WOULD HAVE CAUSED THE DISASTER
 *
 * It proposed guarding the destructive half inside the migration's SQL. Both
 * ledgers key on the sha256 of the file, so editing a released migration
 * un-maps every row a production database already holds — the CLI re-runs it
 * and so does this runner. The SQL of a shipped migration is immutable; the fix
 * has to live in the runner. See `packages/db/src/auto-migrate.ts`.
 *
 * WHAT IS ASSERTED HERE
 *
 * Two independent mechanisms, because the first one does not cover a database
 * with no ledger at all:
 *   1. adoption — a CLI ledger is read and believed, so nothing replays;
 *   2. refusal  — a file that also transforms data is never replayed, whatever
 *      the ledgers say, and the refusal is loud.
 *
 * The finding named two migrations. The classifier finds six.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle as drizzleBunSqlite } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
// The SUBPATH, not the root barrel — the module statically imports both
// migration bundles. Same reason `workspace-status.test.ts` states.
import { ensureMigrations, isTransformStatement } from "@backlex/db/auto-migrate";
import { MIGRATIONS as SQLITE_BUNDLE } from "@backlex/db/sqlite/migrations-bundle";
import { MIGRATIONS as PG_BUNDLE } from "@backlex/db/pg/migrations-bundle";
import { PGLITE_BOOT_TIMEOUT_MS } from "./setup";
import { PG_TESTS_OPTIONAL } from "./setup-pg";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "packages/db/drizzle/sqlite");

/** The rebuild the audit found, and the one it did not mention. Named so a
 *  rename fails here loudly instead of making the assertions test nothing. */
const REBUILD_TAG = "20260510120000_per_workspace_collections";
const ROOMS_TAG = "20260725150000_agent_rooms";
/** A file that only ADDS a column. Its replay must stay tolerated — the
 *  refusal below is about transforms, and a guard that also refused these
 *  would break the case `signing-keys-tenant.test.ts` covers. */
const ADDITIVE_TAG = "20260829090000_signing_keys_tenant_id";

const tmpDbs: string[] = [];

/** A temp SQLite file brought fully current the way the DOCUMENTED CLI does:
 *  every file applied, hashes recorded in `__drizzle_migrations`. Drizzle's own
 *  migrator is used rather than spawning `migrate.ts` because it writes the
 *  identical ledger (`sqlite-core` defaults `migrationsTable` to
 *  `__drizzle_migrations`) and hashes the file the identical way — which the
 *  first test proves rather than assumes. */
const cliMigrated = (): Database => {
  const dir = mkdtempSync(join(tmpdir(), "faz8-"));
  tmpDbs.push(dir);
  const client = new Database(join(dir, "t.sqlite"), { create: true });
  client.exec("PRAGMA foreign_keys = ON");
  migrate(drizzleBunSqlite({ client }), { migrationsFolder: MIGRATIONS_DIR });
  return client;
};

/** A workspace plus a collection that WRAPS a table backlex did not create.
 *  `adopted` is the column that matters: it is the difference between "leave
 *  this table alone" and "this is mine to ALTER and drop fields from". */
const seedAdoptedCollection = (client: Database): void => {
  const now = Date.now();
  client.run(
    "INSERT INTO tenants (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)",
    ["t1", "acme", "Acme", now, now] as never,
  );
  client.run(
    `INSERT INTO collections
       (id, slug, tenant_id, physical_table, fields, adopted, icon, hidden, group_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ["c1", "posts", "t1", "legacy_wp_posts", "[]", 1, "star", 1, "Content", now, now] as never,
  );
};

const collectionMeta = (client: Database) =>
  client.query("SELECT adopted, icon, hidden, group_name FROM collections WHERE id = 'c1'").get() as
    | { adopted: number; icon: string | null; hidden: number; group_name: string | null }
    | null;

/** `ensureMigrations` memoizes its outcome in a WeakMap keyed on the db HANDLE,
 *  so every call in this file needs a fresh drizzle wrapper over the same
 *  client. Getting this wrong makes a second call return the first's result and
 *  the assertion below it means nothing. */
const runner = (client: Database) => drizzleBunSqlite({ client }) as never;

const ledgerNames = (client: Database): string[] =>
  (client.query("SELECT name FROM __backlex_migrations ORDER BY name").all() as Array<{
    name: string;
  }>).map((r) => r.name);

describe("auto-migrate: a database a CLI already migrated is adopted, not replayed", () => {
  test("the CLI ledger is read, every file is adopted, and nothing executes", async () => {
    const client = cliMigrated();
    seedAdoptedCollection(client);
    const before = collectionMeta(client);

    const outcome = await ensureMigrations(runner(client), "sqlite");

    // The whole bundle recognised. `applied` empty is the assertion that
    // matters: it is the difference between "138 files ran again" and "none
    // did". If the manifest's hashing ever stops matching the writers', this
    // is what goes red.
    expect(outcome.adopted.length).toBe(SQLITE_BUNDLE.length);
    expect(outcome.applied).toEqual([]);
    expect(outcome.failed).toEqual([]);
    expect(outcome.adopted).toContain(REBUILD_TAG);

    // The payload. Every one of these was reset by the replay.
    expect(collectionMeta(client)).toEqual(before);
    expect(collectionMeta(client)).toEqual({
      adopted: 1,
      icon: "star",
      hidden: 1,
      group_name: "Content",
    });
    client.close();
  });

  test("adoption writes the runner's own ledger, so the second boot is a no-op", async () => {
    const client = cliMigrated();
    await ensureMigrations(runner(client), "sqlite");
    expect(ledgerNames(client).length).toBe(SQLITE_BUNDLE.length);

    const second = await ensureMigrations(runner(client), "sqlite");
    expect(second.adopted).toEqual([]);
    expect(second.applied).toEqual([]);
    expect(second.failed).toEqual([]);
    client.close();
  });

  test("a migration the CLI has NOT applied still runs", async () => {
    const client = cliMigrated();
    // Rewind one file out of the CLI ledger by its hash — the shape a database
    // is in when it was migrated by an older bundle than the one deployed.
    const sqlText = readFileSync(
      resolve(MIGRATIONS_DIR, ADDITIVE_TAG, "migration.sql"),
      "utf8",
    );
    const hash = createHash("sha256").update(sqlText).digest("hex");
    client.run("DELETE FROM __drizzle_migrations WHERE hash = ?", [hash] as never);

    const outcome = await ensureMigrations(runner(client), "sqlite");
    expect(outcome.adopted).not.toContain(ADDITIVE_TAG);
    // It runs, and its ADD COLUMN is tolerated because the column is there —
    // the file is purely additive, so this is the ORIGINAL tolerance still
    // working, not the new refusal.
    expect(outcome.applied).toContain(ADDITIVE_TAG);
    expect(outcome.failed).toEqual([]);
    client.close();
  });

  test("two isolates adopting at once do not collide", async () => {
    // `seen` is read once, before the adoption loop, and the ledger's `name` is
    // a PRIMARY KEY — so two processes booting together both decide a migration
    // is unrecorded and both INSERT it. Unguarded, the loser's INSERT throws out
    // of `apply` and that process applies NOTHING. `ensureMigrations` memoizes
    // per db HANDLE, so two handles over one file is the same collision.
    const client = cliMigrated();
    const [a, b] = await Promise.all([
      ensureMigrations(runner(client), "sqlite"),
      ensureMigrations(runner(client), "sqlite"),
    ]);
    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    expect(a.applied).toEqual([]);
    expect(b.applied).toEqual([]);
    // Between them every migration is recorded exactly once — the PRIMARY KEY
    // guarantees it, and the point is that reaching it did not throw.
    expect(ledgerNames(client).length).toBe(SQLITE_BUNDLE.length);
    client.close();
  });

  test("adoption is keyed on the file's hash, so a ledger row for other SQL claims nothing", async () => {
    const client = cliMigrated();
    client.run("UPDATE __drizzle_migrations SET hash = 'not-a-real-migration-hash' WHERE id = 1");
    const outcome = await ensureMigrations(runner(client), "sqlite");
    // One row no longer resolves, so one migration is not adopted. It is the
    // hash that decides, not the row count.
    expect(outcome.adopted.length).toBe(SQLITE_BUNDLE.length - 1);
    client.close();
  });
});

describe("auto-migrate: a file that transforms data is refused, never replayed", () => {
  /** A database that is fully current but whose provenance this runner cannot
   *  establish: a data-only restore, a `drizzle-kit push`-provisioned schema, a
   *  ledger table dropped by hand. Adoption has nothing to read, so the second
   *  mechanism is the only thing standing between the bundle and the data. */
  const currentButUnledgered = (): Database => {
    const client = cliMigrated();
    client.run("DROP TABLE __drizzle_migrations");
    return client;
  };

  test("the collection metadata survives a bundle replay with no ledger at all", async () => {
    const client = currentButUnledgered();
    seedAdoptedCollection(client);

    const outcome = await ensureMigrations(runner(client), "sqlite");

    expect(outcome.adopted).toEqual([]);
    expect(collectionMeta(client)).toEqual({
      adopted: 1,
      icon: "star",
      hidden: 1,
      group_name: "Content",
    });
    // And the table still has every column the bundle ends with — the rebuild
    // did not drop and re-create it.
    const cols = (client.query("PRAGMA table_info(collections)").all() as Array<{ name: string }>)
      .length;
    expect(cols).toBeGreaterThan(30);
    client.close();
  });

  test("every transform-carrying file is refused by name — the audit found two of six", async () => {
    const client = currentButUnledgered();
    const outcome = await ensureMigrations(runner(client), "sqlite");

    const refused = outcome.failed.map((f) => f.name);
    // The two the finding named...
    expect(refused).toContain(REBUILD_TAG);
    expect(refused).toContain(ROOMS_TAG);
    // ...and the four it did not. Each is a real transform: a DROP TABLE, two
    // tenant backfills and a derived-column recompute over every analytics row.
    expect(refused).toContain("20260504034356_warm_stone_men");
    expect(refused).toContain("20260510150000_folders_tenant_id");
    expect(refused).toContain("20260510160000_roles_apikeys_tenant_id");
    expect(refused).toContain("20260818210000_analytics_path_base");
    // Everything else ran. A refusal that swallowed the bundle would be a
    // different bug wearing this one's clothes.
    expect(outcome.applied.length).toBe(SQLITE_BUNDLE.length - refused.length);
    client.close();
  });

  test("the refusal says which file and how to repair the ledger", async () => {
    const client = currentButUnledgered();
    const outcome = await ensureMigrations(runner(client), "sqlite");
    const rebuild = outcome.failed.find((f) => f.name === REBUILD_TAG);
    expect(rebuild).toBeDefined();
    // The message has to carry the evidence (what was already there) and the
    // way out — otherwise an operator reading a boot log learns only that
    // something refused.
    expect(rebuild?.error).toContain("duplicate column name: id");
    expect(rebuild?.error).toContain("transforms data");
    expect(rebuild?.error).toContain("INSERT INTO __backlex_migrations");
    expect(rebuild?.error).toContain(REBUILD_TAG);
  });

  test("a refused file is NOT ledgered, so the alarm repeats until it is fixed", async () => {
    const client = currentButUnledgered();
    await ensureMigrations(runner(client), "sqlite");
    expect(ledgerNames(client)).not.toContain(REBUILD_TAG);

    // Same refusal on the next cold start, and still no data loss. Marking it
    // applied would silence a database whose state nobody has established.
    const second = await ensureMigrations(runner(client), "sqlite");
    expect(second.failed.map((f) => f.name)).toContain(REBUILD_TAG);
    client.close();
  });

  test("recording the file by hand is the documented way out, and it works", async () => {
    const client = currentButUnledgered();
    await ensureMigrations(runner(client), "sqlite");
    // Exactly the statement the refusal prints.
    client.run("INSERT INTO __backlex_migrations (name) VALUES (?)", [REBUILD_TAG] as never);

    const outcome = await ensureMigrations(runner(client), "sqlite");
    expect(outcome.failed.map((f) => f.name)).not.toContain(REBUILD_TAG);
    client.close();
  });

  test("on a FRESH database the refusal is inert — the bundle applies in full", async () => {
    // The property that makes this guard safe to ship: it can only fire behind
    // an "already exists", which a database nobody has migrated cannot produce.
    const dir = mkdtempSync(join(tmpdir(), "faz8-fresh-"));
    tmpDbs.push(dir);
    const client = new Database(join(dir, "t.sqlite"), { create: true });
    client.exec("PRAGMA foreign_keys = ON");

    const outcome = await ensureMigrations(runner(client), "sqlite");
    expect(outcome.failed).toEqual([]);
    expect(outcome.adopted).toEqual([]);
    expect(outcome.applied.length).toBe(SQLITE_BUNDLE.length);
    // And the rebuild really did run: `collections` has its post-rebuild
    // primary key, which is the migration's own postcondition.
    const pk = (
      client.query("PRAGMA table_info(collections)").all() as Array<{ name: string; pk: number }>
    ).find((c) => c.pk === 1);
    expect(pk?.name).toBe("id");
    client.close();
  });
});

describe("the classifier reads SQL, not a list of filenames", () => {
  // The REAL predicate, imported. An earlier draft of this spec re-declared the
  // regex here, which is the two-implementations-of-one-invariant shape this
  // repo keeps paying for: the copy goes on passing after the original changes.
  const transformingTags = SQLITE_BUNDLE.filter((m) =>
    m.sql
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean)
      .some(isTransformStatement),
  ).map((m) => m.name);

  /**
   * One case per alternative in the pattern, because the shipped bundle does
   * not exercise them all.
   *
   * Found by breaking the guard: deleting `RENAME TO` from the regex left this
   * whole file green, because every migration that renames a table also drops
   * or inserts into one, so a sibling alternative caught the file anyway. Three
   * rules (`RENAME TO`, `RENAME COLUMN`, `DROP COLUMN`) were decoration as far
   * as any test could tell. They are kept — a standalone rename IS destructive
   * on replay — so they are asserted directly instead of through a file that
   * happens to contain one. Phase 7 met the same shape and deleted its rule;
   * the difference is that this one covers a case the others do not.
   */
  const TRANSFORMS: ReadonlyArray<[string, string]> = [
    ["INSERT INTO `x` (a) SELECT a FROM `y`", "copy into a rebuild table"],
    ["INSERT OR IGNORE INTO `x` (a) VALUES (1)", "seed"],
    ["UPDATE `x` SET a = 1 WHERE a IS NULL", "backfill"],
    ["DELETE FROM `x` WHERE k = 'gone'", "cleanup"],
    ["DROP TABLE `x`", "the rebuild's drop"],
    ["ALTER TABLE `x_new` RENAME TO `x`", "the rebuild's swap"],
    ["ALTER TABLE `x` RENAME COLUMN `a` TO `b`", "standalone rename"],
    ["ALTER TABLE `x` DROP COLUMN `a`", "standalone drop"],
    ["  update `x` set a = 1", "leading space + lower case"],
  ];

  const ADDITIVE: ReadonlyArray<[string, string]> = [
    ["CREATE TABLE `x` (`id` text PRIMARY KEY NOT NULL)", "create"],
    ["ALTER TABLE `x` ADD COLUMN `a` text", "add column"],
    ["CREATE UNIQUE INDEX `x_idx` ON `x` (`a`)", "create index"],
    ["DROP INDEX IF EXISTS `x_idx`", "an index is recreated, not lost"],
    ["PRAGMA foreign_keys = OFF", "pragma"],
    ["CREATE TABLE `updates` (`id` text)", "a TABLE named like a verb"],
  ];

  for (const [stmt, label] of TRANSFORMS) {
    test(`transform: ${label}`, () => {
      expect(isTransformStatement(stmt)).toBe(true);
    });
  }
  for (const [stmt, label] of ADDITIVE) {
    test(`additive: ${label}`, () => {
      expect(isTransformStatement(stmt)).toBe(false);
    });
  }

  test("the shipped bundle's transform set is the one the runner refuses", async () => {
    const client = cliMigrated();
    client.run("DROP TABLE __drizzle_migrations");
    const outcome = await ensureMigrations(runner(client), "sqlite");
    // Every refusal is a file this predicate also calls a transform. The
    // reverse does not hold: a transform-carrying file whose leading statements
    // raise nothing (it creates nothing) simply replays, which is what
    // `20260829120000_app_settings_global_sentinel` does.
    for (const f of outcome.failed) expect(transformingTags).toContain(f.name);
    client.close();
  });

  test("a purely additive migration is not in the transform set", () => {
    expect(transformingTags).not.toContain(ADDITIVE_TAG);
    expect(transformingTags).not.toContain("20260829110000_tenant_status");
    expect(transformingTags).toContain(REBUILD_TAG);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Postgres — the OTHER half of `CLI_LEDGER_SELECT`, and the one a typo would
// hide forever.
//
// The adoption read is wrapped in a `try/catch` that treats any error as "no
// CLI ledger here", because that is the ordinary state of a database this
// runner provisioned itself. Which means a wrong table name, a wrong schema, or
// a driver whose `execute` shape differs would not fail — it would silently
// stop adopting on Postgres and nobody would learn until a self-hosted PG
// instance replayed its bundle. Exactly the "a 2xx that did nothing" shape.
//
// So the pg branch is driven for real: drizzle's own pg migrator writes
// `drizzle.__drizzle_migrations` (schema `drizzle`, hash column), which is
// precisely what `adoptCliLedger` reads.
// ─────────────────────────────────────────────────────────────────────────────
describe("auto-migrate (pg): the CLI ledger is adopted there too", () => {
  test(
    "a pglite database migrated by drizzle's migrator is adopted, not replayed",
    async () => {
      let PGlite: typeof import("@electric-sql/pglite").PGlite;
      let vector: unknown;
      try {
        ({ PGlite } = await import("@electric-sql/pglite"));
        ({ vector } = await import("@electric-sql/pglite/vector"));
      } catch (err) {
        // Same rule as `auto-migrate-pg.test.ts`: pglite needs nothing
        // external, so a probe that cannot boot is a defect, not an
        // environment. Skipping is opt-in and loud.
        if (!PG_TESTS_OPTIONAL) throw err;
        return;
      }
      const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
      const { migrate: migratePg } = await import("drizzle-orm/pglite/migrator");

      // `{ client: pg }`, NOT positional — the beta-22 driver destructures its
      // first argument as config, so a bare instance silently constructs a
      // fresh EMPTY database with no pgvector. See setup-pg.ts.
      const pg = new PGlite({ extensions: { vector } as never });
      await pg.waitReady;
      await pg.exec("CREATE EXTENSION IF NOT EXISTS vector");
      try {
        // The CLI path: `db:migrate:pg` is `migrate(db, { migrationsFolder })`.
        await migratePg(drizzlePglite({ client: pg }), {
          migrationsFolder: resolve(REPO_ROOT, "packages/db/drizzle/pg"),
        });

        const outcome = await ensureMigrations(
          drizzlePglite({ client: pg }) as never,
          "pg",
        );

        // pglite is not 100% Postgres, so the migrator may leave a file
        // unrecorded — assert forward progress and, above all, that nothing
        // EXECUTED. `applied` empty is the whole claim: the schema-qualified
        // read found the ledger and the hashes resolved.
        expect(outcome.adopted.length).toBeGreaterThan(0);
        expect(outcome.adopted.length).toBeLessThanOrEqual(PG_BUNDLE.length);
        expect(outcome.applied).toEqual([]);
        expect(outcome.failed).toEqual([]);
      } finally {
        await pg.close();
      }
    },
    PGLITE_BOOT_TIMEOUT_MS,
  );
});

// Temp directories are per-test and small, but 640 spec files share one system
// file table — see CLAUDE.md on why the worker count is pinned. Clean up.
process.on("exit", () => {
  for (const dir of tmpDbs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
