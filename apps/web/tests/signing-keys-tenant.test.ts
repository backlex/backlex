/**
 * `signing_keys.tenant_id` — the column, and nothing but the column.
 *
 * The defect this closes is narrow and worth stating precisely. `signing_keys`
 * carried no tenant column at all, so on a deployment holding more than one
 * workspace the same key pair and the same issuer sign every workspace's
 * app-plane access tokens: a relying party verifying by JWKS and issuer accepts
 * workspace A's token as workspace B's unless it independently checks the `tid`
 * claim, which nothing authenticates on its own. Rotation is all-or-nothing
 * across every workspace for the same reason.
 *
 * The full fix — per-workspace issuance, per-workspace JWKS endpoints, rotation
 * scoped to one workspace — is much larger than this step, and doing half of it
 * is worse than none: making the readers tenant-aware while every existing key
 * is instance-level would leave those keys unmatched and break verification of
 * tokens already in the wild. So this step adds a NULLABLE column that nothing
 * reads, and this spec pins exactly that much:
 *
 *   1. Both dialect schemas declare it, nullable, with no default.
 *   2. A migrated SQLite database really has it, and it really holds NULL for a
 *      row written without one — with a positive control (a row written WITH a
 *      tenant id round-trips) so "always NULL" cannot pass vacuously.
 *   3. The migration is replayable: re-running it over a database that already
 *      has the column is a no-op rather than an error, and the rows that were
 *      there before are untouched.
 *   4. The same, on a real Postgres parser via pglite.
 *
 * (3) is the load-bearing one. `auto-migrate.ts` re-applies every migration file
 * whose name is absent from `__backlex_migrations`, which is the boot path on
 * Vercel and Netlify, so a migration that throws on a second pass would be
 * recorded as `failed` on every cold start of a database that already had the
 * column. SQLite has no `ADD COLUMN IF NOT EXISTS`; what saves the replay is
 * `ALREADY_EXISTS_RE` matching `duplicate column`, and the test below proves the
 * tolerance is doing that work by first showing the bare statement DOES throw.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle as drizzleBunSqlite } from "drizzle-orm/bun-sqlite";
import { getTableColumns } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// The SUBPATH, not the root barrel. `packages/db/src/index.ts` deliberately
// re-exports only `auto-migrate`'s TYPES: the module statically imports both
// migration bundles, and pulling it through the barrel would drag ~700 KB of
// SQL into every cold isolate that touches `@backlex/db` for anything at all.
// `auto-migrate-pg.test.ts` imports it the same way.
import { ensureMigrations } from "@backlex/db/auto-migrate";
import { schema as pgSchema } from "@backlex/db/pg";
import { schema as sqliteSchema } from "@backlex/db/sqlite";
import { PGLITE_BOOT_TIMEOUT_MS } from "./setup";
import { PG_TESTS_OPTIONAL } from "./setup-pg";

/** The migration this spec is about. Named once so a rename fails loudly here
 *  instead of quietly making the replay assertions test nothing. */
const TAG = "20260829090000_signing_keys_tenant_id";
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const migrationSql = (dialect: "pg" | "sqlite"): string =>
  readFileSync(
    resolve(REPO_ROOT, "packages/db/drizzle", dialect, TAG, "migration.sql"),
    "utf8",
  );

// ---------------------------------------------------------------------------
// 1. Both dialect schemas declare it
// ---------------------------------------------------------------------------

describe("signing_keys.tenant_id — schema declaration", () => {
  for (const [dialect, table] of [
    ["pg", pgSchema.signingKeys],
    ["sqlite", sqliteSchema.signingKeys],
  ] as const) {
    test(`${dialect} declares tenant_id, nullable, with no default`, () => {
      const col = Object.values(getTableColumns(table)).find(
        (c) => (c as { name: string }).name === "tenant_id",
      ) as { notNull: boolean; hasDefault: boolean } | undefined;
      expect(col).toBeDefined();
      // NULL is the whole design: it means "the instance's own key", which is
      // what every row written before this column existed is. A NOT NULL column
      // would have forced a back-fill, and guessing a tenant for a live key
      // silently re-scopes a credential.
      expect(col?.notNull).toBe(false);
      expect(col?.hasDefault).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 2 + 3. A migrated SQLite database, and a replay over it
// ---------------------------------------------------------------------------

describe("signing_keys.tenant_id — migrated sqlite", () => {
  let tmp: string;
  let client: Database;

  /** Column metadata straight out of the migrated database, not out of the
   *  schema file — the two can disagree, and that disagreement is the bug this
   *  half exists to catch. */
  const tenantIdColumn = ():
    | { name: string; notnull: number; dflt_value: unknown }
    | undefined =>
    (
      client.query("PRAGMA table_info(signing_keys)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
      }>
    ).find((c) => c.name === "tenant_id");

  const insertKey = (id: string, tenantId: string | null): void => {
    client.run(
      `INSERT INTO signing_keys
         (id, kid, alg, private_key, public_key, status, tenant_id, created_at)
       VALUES (?, ?, 'ES256', 'enc:v1:x', 'pem', 'standby', ?, ?)`,
      [id, `kid-${id}`, tenantId, Date.now()],
    );
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "backlex-sk-tenant-"));
    client = new Database(join(tmp, "test.sqlite"), { create: true });
    client.exec("PRAGMA journal_mode = WAL");
    const outcome = await ensureMigrations(drizzleBunSqlite({ client }), "sqlite");
    // The bundle has to have actually run — otherwise every assertion below
    // would be about a database nobody migrated.
    expect(outcome.failed).toEqual([]);
    expect(outcome.applied).toContain(TAG);
  });

  afterEach(() => {
    try {
      client.close();
    } catch {
      /* already closed */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test("the column exists, is nullable, and has no default", () => {
    const col = tenantIdColumn();
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  });

  test("a key written without a tenant reads back NULL, and one written with a tenant keeps it", () => {
    insertKey("k-instance", null);
    insertKey("k-scoped", "tenant-abc");

    const rows = client
      .query("SELECT id, tenant_id FROM signing_keys ORDER BY id")
      .all() as Array<{ id: string; tenant_id: string | null }>;

    // The second row is the positive control: if the column were ignored on
    // write, or coerced by the driver, `k-scoped` would come back NULL too and
    // the NULL assertion on `k-instance` would be passing for the wrong reason.
    expect(rows).toEqual([
      { id: "k-instance", tenant_id: null },
      { id: "k-scoped", tenant_id: "tenant-abc" },
    ]);
  });

  test("the bare ALTER really does fail on a second pass — the tolerance is what saves it", () => {
    // Proving the premise of the replay test below. If SQLite ever grew
    // `ADD COLUMN IF NOT EXISTS` semantics, this assertion flips and the replay
    // test would no longer be exercising `ALREADY_EXISTS_RE` at all.
    let message = "";
    try {
      client.exec(migrationSql("sqlite"));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/duplicate column/i);
  });

  test("re-applying the migration over a database that already has the column is a no-op", async () => {
    insertKey("k-before", "tenant-before");

    // Put the ledger back to where a database that never saw this migration
    // would be, so `ensureMigrations` genuinely re-executes the file rather than
    // skipping it by name. A fresh drizzle handle is required as well: the
    // runner memoizes its outcome in a WeakMap keyed on the handle.
    client.run("DELETE FROM __backlex_migrations WHERE name = ?", [TAG]);
    const second = await ensureMigrations(drizzleBunSqlite({ client }), "sqlite");

    // Re-executed (so the ALTER really did run again) and survived it.
    expect(second.applied).toContain(TAG);
    expect(second.failed).toEqual([]);

    // Still exactly one column, and the row that was there first is untouched.
    const cols = (
      client.query("PRAGMA table_info(signing_keys)").all() as Array<{ name: string }>
    ).filter((c) => c.name === "tenant_id");
    expect(cols.length).toBe(1);
    expect(
      client.query("SELECT tenant_id FROM signing_keys WHERE id = 'k-before'").get(),
    ).toEqual({ tenant_id: "tenant-before" });
  });
});

// ---------------------------------------------------------------------------
// 4. The same statement against a real Postgres parser
// ---------------------------------------------------------------------------

let pgliteWorks = false;
let setupErr: Error | undefined;

beforeAll(async () => {
  try {
    const { PGlite } = await import("@electric-sql/pglite");
    const probe = new PGlite();
    await probe.waitReady;
    pgliteWorks = true;
    await probe.close();
  } catch (err) {
    setupErr = err instanceof Error ? err : new Error(String(err));
    // Same rule as the rest of the suite: pglite needs nothing external, so a
    // probe that cannot boot is a defect and not an environment. Skipping is
    // opt-in and loud.
    if (!PG_TESTS_OPTIONAL) {
      throw new Error(
        "[signing-keys-tenant] pglite could not boot, so the pg half of this spec " +
          "would have asserted nothing. Fix the cause, or re-run with " +
          `BACKLEX_PG_TESTS=optional. Cause: ${setupErr.message}`,
        { cause: setupErr },
      );
    }
  }
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(() => {
  if (setupErr) {
    console.warn(
      "[signing-keys-tenant] pg half skipped — pglite unavailable here:",
      setupErr.message.slice(0, 200),
    );
  }
});

describe("signing_keys.tenant_id — migrated pg", () => {
  test("the column lands nullable, and a second apply changes nothing", async () => {
    // Only reachable under `BACKLEX_PG_TESTS=optional`; otherwise `beforeAll`
    // has already failed loudly.
    if (!pgliteWorks) return;
    const { PGlite } = await import("@electric-sql/pglite");
    // No pgvector and no full bundle: this spec is about one ALTER against the
    // one table it touches, so it builds that table from the migration that
    // created it and applies the new one on top. Replaying all 128 pg
    // migrations here would test the bundle, which `migration-parity.test.ts`
    // and `auto-migrate-pg.test.ts` already do, at seconds of WASM Postgres per
    // run. Raw `exec` (simple protocol) throughout, like every other pglite
    // caller in this suite.
    const pg = new PGlite();
    await pg.waitReady;
    try {
      for (const stmt of readFileSync(
        resolve(
          REPO_ROOT,
          "packages/db/drizzle/pg/20260811140000_signing_keys/migration.sql",
        ),
        "utf8",
      )
        .split(/-->\s*statement-breakpoint\s*/i)
        .map((s) => s.trim())
        .filter(Boolean)) {
        await pg.exec(stmt);
      }

      // A key that predates the column, exactly like every row in production.
      await pg.exec(
        `INSERT INTO signing_keys (id, kid, alg, private_key, public_key, status)
         VALUES ('k-legacy', 'kid-legacy', 'ES256', 'enc:v1:x', 'pem', 'in_use')`,
      );

      await pg.exec(migrationSql("pg"));

      const described = (
        await pg.query(
          `SELECT is_nullable, column_default FROM information_schema.columns
            WHERE table_name = 'signing_keys' AND column_name = 'tenant_id'`,
        )
      ).rows as Array<{ is_nullable: string; column_default: string | null }>;
      expect(described).toEqual([{ is_nullable: "YES", column_default: null }]);

      // No back-fill: the pre-existing key is still the instance's own.
      expect(
        (await pg.query("SELECT tenant_id FROM signing_keys WHERE id = 'k-legacy'"))
          .rows,
      ).toEqual([{ tenant_id: null }]);

      // Replay. `ADD COLUMN IF NOT EXISTS` means Postgres does not even raise,
      // so unlike SQLite there is nothing for the tolerance to catch.
      await pg.exec(migrationSql("pg"));
      expect(
        (
          await pg.query(
            `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'signing_keys' AND column_name = 'tenant_id'`,
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      expect(
        (await pg.query("SELECT tenant_id FROM signing_keys WHERE id = 'k-legacy'"))
          .rows,
      ).toEqual([{ tenant_id: null }]);
    } finally {
      await pg.close();
    }
  }, PGLITE_BOOT_TIMEOUT_MS);
});
