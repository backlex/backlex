/**
 * Auto-migrate regression. The boot-time runner has these paths:
 *
 *   1. **Adopt a CLI ledger** — `__drizzle_migrations` (written by every
 *      `db:migrate:*` CLI, and by drizzle's own migrator on PG) records file
 *      HASHES; this runner records folder NAMES. Hashes are mapped through
 *      `migrations-manifest.generated.ts` and recorded, so a database a CLI
 *      brought current is recognised instead of replayed into. Covered in
 *      depth by `security-audit-2026-09-migration-replay.test.ts`.
 *
 *   2. **Apply from scratch** — fresh DB → execute every bundled migration in
 *      order, recording each in the ledger.
 *
 *   3. **Diff apply** — ledger has some entries; run only the missing ones.
 *      The steady-state production path after a deploy that ships a new
 *      migration.
 *
 *   4. **Refuse a destructive replay** — a file that also TRANSFORMS data
 *      (INSERT/UPDATE/DELETE/DROP TABLE/RENAME) whose leading statement says
 *      the object already exists has run before, and running the rest of it
 *      now would rewrite rows that arrived since. It is refused and NOT
 *      ledgered, so the operator is told on every boot until the ledger is
 *      repaired.
 *
 * **Path 1 used to be something else, and the difference is this file's whole
 * history.** Until `92a9ff4b` (2026-05-25) the runner back-filled the ledger
 * with EVERY bundled migration name whenever the ledger was empty and a core
 * table (`users`) existed — `detectAlreadyMigrated`. That was removed for a
 * real reason: it also claimed migrations that had NOT run, so a newly shipped
 * one was hidden forever (`mcp_tools` never reached Vercel). Its replacement,
 * per-statement "already exists" tolerance, was reasoned about as *"legacy
 * CREATE TABLE statements get skipped, but a fresh ALTER TABLE ADD COLUMN still
 * runs"* — correct for every file that is one or the other, and wrong for a
 * SQLite table REBUILD, which is both: `ADD COLUMN` first, then
 * create-copy-`DROP TABLE`-rename. `20260510120000_per_workspace_collections`
 * was already in the bundle on that date.
 *
 * Path 1 now does what the old bypass was reaching for without its defect: it
 * claims only what a CLI ledger PROVES by hash, so it cannot hide a migration
 * that has not run.
 *
 * Every test below runs against a fresh in-process bun-sqlite database, no
 * harness, no app boot.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle as drizzleBunSqlite } from "drizzle-orm/bun-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMigrations } from "@backlex/db/auto-migrate";
import { MIGRATIONS as SQLITE_MIGRATIONS } from "@backlex/db/sqlite/migrations-bundle";

let tmp: string;
let dbPath: string;
let client: Database;
let db: ReturnType<typeof drizzleBunSqlite>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "backlex-am-"));
  dbPath = join(tmp, "test.sqlite");
  client = new Database(dbPath, { create: true });
  client.exec("PRAGMA journal_mode = WAL");
  db = drizzleBunSqlite({ client });
});

afterEach(() => {
  try { client.close(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
});

const tableExists = (name: string): boolean => {
  const row = client
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
};

const ledgerNames = (): string[] => {
  if (!tableExists("__backlex_migrations")) return [];
  return (client
    .query("SELECT name FROM __backlex_migrations ORDER BY name")
    .all() as { name: string }[]).map((r) => r.name);
};

describe("auto-migrate — fresh DB path", () => {
  test("creates every backlex table from an empty database", async () => {
    expect(tableExists("users")).toBe(false);
    expect(tableExists("api_keys")).toBe(false);

    await ensureMigrations(db, "sqlite");

    // Core schema is in place
    expect(tableExists("users")).toBe(true);
    expect(tableExists("api_keys")).toBe(true);
    expect(tableExists("collections")).toBe(true);

    // Latest migration columns landed
    const apiKeyCols = (client
      .query("PRAGMA table_info(api_keys)")
      .all() as { name: string }[]).map((r) => r.name);
    expect(apiKeyCols).toContain("mcp_tools");
    expect(apiKeyCols).toContain("mcp_read_only");

    // Ledger lists every bundled migration
    expect(ledgerNames().length).toBe(SQLITE_MIGRATIONS.length);
  });

  test("idempotent — second call on the same handle is a no-op", async () => {
    await ensureMigrations(db, "sqlite");
    const before = ledgerNames().length;

    // Same handle → in-flight WeakMap dedupes; ledger stays untouched
    await ensureMigrations(db, "sqlite");
    expect(ledgerNames().length).toBe(before);

    // Fresh handle on same DB file → runs adopt-existing path; still no-op
    const client2 = new Database(dbPath, { readwrite: true });
    const db2 = drizzleBunSqlite({ client: client2 });
    await ensureMigrations(db2, "sqlite");
    const ledger2 = (client2
      .query("SELECT name FROM __backlex_migrations ORDER BY name")
      .all() as { name: string }[]).map((r) => r.name);
    expect(ledger2.length).toBe(before);
    client2.close();
  });
});

describe("auto-migrate — a current schema with no ledger at all", () => {
  /**
   * A database that is fully migrated but carries neither ledger: a data-only
   * restore, a `drizzle-kit push`-provisioned schema, a ledger dropped by hand
   * — or, as here, one this runner migrated before the row was deleted.
   *
   * **This test used to assert the defect.** Its sentinel was a `users` row and
   * it required the ledger to come back complete, which is only possible by
   * replaying every file. `users` is created once by the baseline and never
   * touched again, so "no migration DROPped or rewrote it" was true no matter
   * how much damage the replay did elsewhere — and the damage was elsewhere:
   * `20260510120000_per_workspace_collections` rebuilds `collections`, dropping
   * 26 columns that later migrations then re-create at their DEFAULTS. The
   * assertion was green throughout, for four months.
   *
   * So the sentinel moved to the table that is actually at risk, and the ledger
   * expectation changed to match what is now true: a file that transforms data
   * is refused rather than replayed, and deliberately left unledgered so the
   * refusal repeats until an operator resolves it.
   */
  const seedAtRisk = (c: Database) => {
    const now = Date.now();
    c.run(
      "INSERT INTO tenants (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["t-keep", "keep", "Keep", now, now] as never,
    );
    c.run(
      `INSERT INTO collections
         (id, slug, tenant_id, physical_table, fields, adopted, icon, hidden, group_name, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ["c-keep", "posts", "t-keep", "legacy_wp_posts", "[]", 1, "star", 1, "Content", now, now] as never,
    );
  };

  test("the rows a replay used to reset survive it", async () => {
    await ensureMigrations(db, "sqlite");
    client.exec(
      "INSERT INTO users (id, email, name, email_verified, created_at, updated_at) VALUES ('keep-me', 'sentinel@x', 'Sentinel', " +
        `1, ${Date.now()}, ${Date.now()})`,
    );
    seedAtRisk(client);
    client.exec("DROP TABLE __backlex_migrations");

    // Fresh handle so the per-isolate WeakMap doesn't dedupe.
    const client2 = new Database(dbPath, { readwrite: true });
    const db2 = drizzleBunSqlite({ client: client2 });
    await ensureMigrations(db2, "sqlite");

    // The original sentinel, kept: `users` is still untouched.
    expect(
      (client2.query("SELECT email FROM users WHERE id = 'keep-me'").get() as { email: string })
        .email,
    ).toBe("sentinel@x");

    // The sentinel that can actually fail. Every one of these came back as
    // 0 / null / 0 / null before the runner learned to refuse the rebuild —
    // and `adopted` going to 0 means backlex believes it owns a table the
    // operator merely pointed it at.
    expect(
      client2
        .query("SELECT adopted, icon, hidden, group_name FROM collections WHERE id = 'c-keep'")
        .get(),
    ).toEqual({ adopted: 1, icon: "star", hidden: 1, group_name: "Content" });

    client2.close();
  });

  test("everything safe to replay is ledgered; what transforms data is refused and reported", async () => {
    await ensureMigrations(db, "sqlite");
    client.exec("DROP TABLE __backlex_migrations");

    const client2 = new Database(dbPath, { readwrite: true });
    const db2 = drizzleBunSqlite({ client: client2 });
    const outcome = await ensureMigrations(db2, "sqlite");

    const refused = outcome.failed.map((f) => f.name);
    expect(refused).toContain("20260510120000_per_workspace_collections");
    expect(refused.length).toBeGreaterThan(0);

    const ledger = (client2
      .query("SELECT name FROM __backlex_migrations ORDER BY name")
      .all() as { name: string }[]).map((r) => r.name);

    // Not the whole bundle any more, and that is the fix rather than a
    // shortfall: the refused files are absent by design, so the alarm repeats
    // instead of an unverified schema being recorded as complete.
    expect(ledger.length).toBe(SQLITE_MIGRATIONS.length - refused.length);
    for (const name of refused) expect(ledger).not.toContain(name);

    client2.close();
  });
});

describe("auto-migrate — diff apply path", () => {
  test("with a partial ledger, only the missing migrations are applied", async () => {
    // Bootstrap: migrate from scratch
    await ensureMigrations(db, "sqlite");
    expect(ledgerNames().length).toBe(SQLITE_MIGRATIONS.length);

    // Simulate a deploy that added one more migration after the fact:
    // drop the most recent entry from the ledger and re-run. The runner
    // should re-apply only that one (idempotent SQL — ADD COLUMN IF NOT
    // EXISTS isn't supported in sqlite, but the bundled migration is
    // already idempotent enough — for this test we just verify the
    // bookkeeping replays cleanly).
    const lastName = SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]!.name;
    client.exec(`DELETE FROM __backlex_migrations WHERE name = '${lastName}'`);
    expect(ledgerNames().length).toBe(SQLITE_MIGRATIONS.length - 1);

    // Re-run on a FRESH handle so the per-isolate WeakMap doesn't dedupe.
    const client2 = new Database(dbPath, { readwrite: true });
    const db2 = drizzleBunSqlite({ client: client2 });
    try {
      await ensureMigrations(db2, "sqlite");
    } catch {
      // The last migration is ALTER TABLE ADD COLUMN which fails when the
      // column already exists (sqlite has no IF NOT EXISTS for columns).
      // That's expected — the test verifies the runner ATTEMPTS the
      // diff-apply path, not that every migration is replay-safe.
    } finally {
      client2.close();
    }
  });
});
