/**
 * A workspace has a lifecycle, and the instance-global settings tier stops
 * being NULL.
 *
 * Two migrations land together in this phase and this spec pins both, plus the
 * one behaviour that makes the first of them mean anything.
 *
 * ── `tenants.status` ────────────────────────────────────────────────────────
 *
 * `tenants` had no status column, so every workspace in the table was
 * permanently live: an operator holding an abusive or delinquent tenant had no
 * lever short of tearing down the Worker, and there was no way to retire a
 * workspace without deleting its rows. The column is NOT NULL DEFAULT 'active',
 * which is what lets it ship with no back-fill statement — every row that
 * existed before it is correct the instant the column lands, and there is no
 * window in which a live workspace reads back NULL and gets refused.
 *
 * The behaviour half is the load-bearing one. A non-active workspace has to
 * answer **exactly** like a workspace the caller does not belong to — same
 * status, same error code, same message — or the status becomes an existence
 * oracle: a signed-in user could probe slugs and read off which workspaces have
 * been suspended from the shape of the refusal alone. `refuseHeaderWorkspace`
 * already collapses "no such workspace" and "not yours" for that reason, and
 * "archived" now joins them. The test below compares the two responses BYTE FOR
 * BYTE rather than merely checking both are 404s, because a 404 whose message
 * differs leaks just as much as a 403 would.
 *
 * ── the `app_settings` global sentinel ──────────────────────────────────────
 *
 * The instance-wide settings tier was addressed as `tenant_id IS NULL`, which
 * cannot be told apart from a row whose tenant column was never filled in — and
 * the repo did not even agree with itself, since several call sites already
 * wrote the literal `'_global'` for the same tier. Two representations of one
 * thing in one table.
 *
 * NULL is worse than ambiguous here, and the spec proves it rather than
 * asserting it: a UNIQUE index treats NULLs as DISTINCT on BOTH engines, so the
 * index that exists to keep one row per key was enforcing nothing at all for
 * the global tier and a long-running deployment can hold several rows for one
 * global key. That is why the migration de-duplicates BEFORE it rewrites — the
 * rewrite is the moment the index starts applying, and running it against
 * duplicates raises a unique violation that would record the whole migration as
 * failed.
 *
 * ── replay ──────────────────────────────────────────────────────────────────
 *
 * `auto-migrate.ts` re-applies every migration file whose name is absent from
 * `__backlex_migrations`, which is the boot path on Vercel and Netlify, so a
 * migration that throws on a second pass is recorded as `failed` on every cold
 * start of a database that already has the change. Both migrations are applied
 * twice here, against one database, and the second pass has to be a no-op — not
 * an error, and not a second helping of data loss.
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
import { ensureMigrations } from "@backlex/db/auto-migrate";
import { schema as pgSchema } from "@backlex/db/pg";
import { schema as sqliteSchema } from "@backlex/db/sqlite";
import { buildTwoPlaneCast, type TwoPlaneCast } from "./fixtures/two-plane-cast";
import { invalidateAllPermissions } from "../src/server/services/permissions-cache";
import { PGLITE_BOOT_TIMEOUT_MS } from "./setup";
import { PG_TESTS_OPTIONAL } from "./setup-pg";

/** The two migrations this spec is about, and the baselines that created the
 *  tables they alter. Named once so a rename fails loudly here instead of
 *  quietly making the assertions below test nothing. */
const STATUS_TAG = "20260829110000_tenant_status";
const SENTINEL_TAG = "20260829120000_app_settings_global_sentinel";
const SQLITE_BASELINE = "20260509212015_talented_machine_man";
const PG_BASELINE = "20260503000000_pg_baseline";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const migrationSql = (dialect: "pg" | "sqlite", tag: string): string =>
  readFileSync(
    resolve(REPO_ROOT, "packages/db/drizzle", dialect, tag, "migration.sql"),
    "utf8",
  );

const statements = (sqlText: string): string[] =>
  sqlText
    .split(/-->\s*statement-breakpoint\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Pull the statements that create `table` (and its indexes) out of a baseline
 * migration.
 *
 * Replaying the whole 130-file chain to test two ALTERs would be testing the
 * bundle, which `migration-parity.test.ts` and `auto-migrate-pg.test.ts`
 * already do at real cost. Reading the real CREATE out of the real baseline
 * keeps this cheap without letting the spec invent its own table shape — a
 * column renamed in the baseline still fails here.
 */
const baselineFor = (
  dialect: "pg" | "sqlite",
  baselineTag: string,
  table: string,
): string[] => {
  const chunks = statements(migrationSql(dialect, baselineTag)).filter((s) =>
    new RegExp(`(CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX)[^;]*[\`"]${table}[\`"]`, "i").test(
      s,
    ),
  );
  if (chunks.length === 0) {
    throw new Error(
      `[workspace-status] no baseline statement creates "${table}" in ${dialect}/${baselineTag} — ` +
        "the migration was renamed or the table was, and every assertion built on it would " +
        "have been about a table this spec made up.",
    );
  }
  return chunks;
};

// ---------------------------------------------------------------------------
// 1. Both dialect schemas declare the columns
// ---------------------------------------------------------------------------

describe("tenants.status / archived_at — schema declaration", () => {
  for (const [dialect, table] of [
    ["pg", pgSchema.tenants],
    ["sqlite", sqliteSchema.tenants],
  ] as const) {
    const column = (name: string) =>
      Object.values(getTableColumns(table)).find(
        (c) => (c as { name: string }).name === name,
      ) as { notNull: boolean; hasDefault: boolean; default?: unknown } | undefined;

    test(`${dialect} declares status NOT NULL defaulting to 'active'`, () => {
      const col = column("status");
      expect(col).toBeDefined();
      // NOT NULL + a default is what makes the migration back-fill-free: the
      // engine fills every existing row as the column is added. Drop the
      // default and every workspace that predates the column reads back NULL
      // and is refused by the middleware on the very next request.
      expect(col?.notNull).toBe(true);
      expect(col?.hasDefault).toBe(true);
      expect(col?.default).toBe("active");
    });

    test(`${dialect} declares archived_at nullable with no default`, () => {
      const col = column("archived_at");
      expect(col).toBeDefined();
      // It records WHEN a workspace was archived. A row that never was has no
      // such moment, and a default would put a fabricated timestamp in front of
      // whoever reads the audit trail.
      expect(col?.notNull).toBe(false);
      expect(col?.hasDefault).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The migrations against a real SQLite engine
// ---------------------------------------------------------------------------

describe("tenants.status — migrated sqlite", () => {
  let tmp: string;
  let client: Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "backlex-ws-status-"));
    client = new Database(join(tmp, "test.sqlite"), { create: true });
    for (const stmt of baselineFor("sqlite", SQLITE_BASELINE, "tenants")) {
      client.exec(stmt);
    }
    // A workspace that predates the column, exactly like every row in a
    // deployment that has been running.
    client.run(
      "INSERT INTO tenants (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["t-legacy", "legacy", "Legacy", 1, 1],
    );
  });

  afterEach(() => {
    try {
      client.close();
    } catch {
      /* already closed */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test("an existing row comes out 'active' with no back-fill statement", () => {
    for (const stmt of statements(migrationSql("sqlite", STATUS_TAG))) client.exec(stmt);

    expect(
      client.query("SELECT status, archived_at FROM tenants WHERE id = 't-legacy'").get(),
    ).toEqual({ status: "active", archived_at: null });

    // And the migration really contains no UPDATE — if a back-fill were added
    // later this assertion is the thing that says the DEFAULT stopped being
    // what makes existing rows correct.
    expect(migrationSql("sqlite", STATUS_TAG)).not.toMatch(/\bUPDATE\b/i);
  });

  test("the column is NOT NULL with the default, read off the migrated database", () => {
    for (const stmt of statements(migrationSql("sqlite", STATUS_TAG))) client.exec(stmt);
    // Read from the DATABASE, not from schema.ts — the two can disagree, and
    // that disagreement is the bug this half exists to catch.
    const cols = client.query("PRAGMA table_info(tenants)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    expect(cols.find((c) => c.name === "status")).toMatchObject({
      notnull: 1,
      dflt_value: "'active'",
    });
    expect(cols.find((c) => c.name === "archived_at")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
  });

  test("the bare ALTER really does fail on a second pass — the tolerance is what saves it", () => {
    // Proving the premise of the replay test below. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`; what makes this file replayable is
    // `auto-migrate.ts`'s `ALREADY_EXISTS_RE` matching `duplicate column`. If
    // SQLite ever grew those semantics this assertion flips and the replay test
    // would no longer be exercising the tolerance at all.
    for (const stmt of statements(migrationSql("sqlite", STATUS_TAG))) client.exec(stmt);
    let message = "";
    try {
      for (const stmt of statements(migrationSql("sqlite", STATUS_TAG))) client.exec(stmt);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/duplicate column/i);
  });
});

describe("app_settings global sentinel — migrated sqlite", () => {
  let tmp: string;
  let client: Database;

  /** `updated_at` is what decides the winner, so the fixtures below are ordered
   *  by it rather than by insertion. */
  const insertSetting = (
    id: string,
    tenantId: string | null,
    key: string,
    updatedAt: number,
  ): void =>
    client.run(
      "INSERT INTO app_settings (id, tenant_id, key, value, updated_at) VALUES (?,?,?,?,?)",
      [id, tenantId, key, JSON.stringify({ from: id }), updatedAt],
    );

  const rows = () =>
    client
      .query("SELECT id, tenant_id, key FROM app_settings ORDER BY id")
      .all() as Array<{ id: string; tenant_id: string | null; key: string }>;

  const applySentinel = () => {
    for (const stmt of statements(migrationSql("sqlite", SENTINEL_TAG))) client.exec(stmt);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "backlex-ws-sentinel-"));
    client = new Database(join(tmp, "test.sqlite"), { create: true });
    for (const stmt of baselineFor("sqlite", SQLITE_BASELINE, "app_settings")) {
      client.exec(stmt);
    }
  });

  afterEach(() => {
    try {
      client.close();
    } catch {
      /* already closed */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test("the unique index does NOT stop duplicate NULL rows — the premise of the de-duplication", () => {
    // Measured, not assumed. This is the reason the migration de-duplicates at
    // all: if the index constrained NULLs there could be at most one global row
    // per key and the DELETE would be dead code. It does not, on either engine
    // (the pg half below asserts the same thing), so a deployment that has been
    // running can genuinely hold several rows for one global key.
    insertSetting("n1", null, "branding", 100);
    insertSetting("n2", null, "branding", 300);
    expect(rows().length).toBe(2);
  });

  test("NULL rows become '_global' and per-tenant rows are untouched", () => {
    insertSetting("n-locale", null, "locale", 100);
    insertSetting("t-a", "tenant-a", "branding", 100);
    insertSetting("t-b", "tenant-b", "branding", 100);

    applySentinel();

    // The two per-tenant rows are the positive control: if the UPDATE were
    // missing its `WHERE tenant_id IS NULL` — or the DELETE its tier predicate
    // — they would have been rewritten or removed, and an assertion that only
    // looked at the global row would have passed anyway.
    expect(rows()).toEqual([
      { id: "n-locale", tenant_id: "_global", key: "locale" },
      { id: "t-a", tenant_id: "tenant-a", key: "branding" },
      { id: "t-b", tenant_id: "tenant-b", key: "branding" },
    ]);
  });

  test("duplicates collapse to the newest updated_at, across BOTH spellings of global", () => {
    // The hard case, and the one a deployment actually has: one key with two
    // NULL rows AND a `'_global'` row, where the newest is a NULL one. All
    // three are competing answers to one question; after the migration exactly
    // one survives and the index finally constrains the tier.
    insertSetting("g-old", "_global", "branding", 200);
    insertSetting("n-oldest", null, "branding", 100);
    insertSetting("n-newest", null, "branding", 300);

    applySentinel();

    expect(rows()).toEqual([{ id: "n-newest", tenant_id: "_global", key: "branding" }]);
    // And the survivor is the row whose VALUE an admin last chose, not merely
    // some row with the right key.
    expect(
      client.query("SELECT value FROM app_settings WHERE key = 'branding'").get(),
    ).toEqual({ value: JSON.stringify({ from: "n-newest" }) });
  });

  test("re-applying it is a no-op — no error, and no second helping of deletion", () => {
    insertSetting("g-old", "_global", "branding", 200);
    insertSetting("n-newest", null, "branding", 300);
    insertSetting("t-a", "tenant-a", "branding", 100);

    applySentinel();
    const afterFirst = rows();
    // Nothing here throws on a second pass, so unlike the ALTER above there is
    // nothing for `ALREADY_EXISTS_RE` to tolerate — the statements simply match
    // no rows.
    applySentinel();
    expect(rows()).toEqual(afterFirst);
    expect(afterFirst).toEqual([
      { id: "n-newest", tenant_id: "_global", key: "branding" },
      { id: "t-a", tenant_id: "tenant-a", key: "branding" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. The whole bundle still applies, and re-applies, on a real database
// ---------------------------------------------------------------------------

describe("both migrations inside the real bundle", () => {
  let tmp: string;
  let client: Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "backlex-ws-bundle-"));
    client = new Database(join(tmp, "test.sqlite"), { create: true });
    client.exec("PRAGMA journal_mode = WAL");
  });

  afterEach(() => {
    try {
      client.close();
    } catch {
      /* already closed */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test("the bundle applies both, and replaying them over the result changes nothing", async () => {
    const first = await ensureMigrations(drizzleBunSqlite({ client }), "sqlite");
    // The bundle has to have actually run — otherwise everything below would be
    // about a database nobody migrated.
    expect(first.failed).toEqual([]);
    expect(first.applied).toContain(STATUS_TAG);
    expect(first.applied).toContain(SENTINEL_TAG);

    client.run(
      "INSERT INTO tenants (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["t-before", "before", "Before", 1, 1],
    );
    client.run(
      "INSERT INTO app_settings (id, tenant_id, key, value, updated_at) VALUES (?,?,?,?,?)",
      ["s-before", "_global", "branding", "{}", 1],
    );

    // Put the ledger back to where a database that never saw these migrations
    // would be, so `ensureMigrations` genuinely re-executes the files rather
    // than skipping them by name. A fresh drizzle handle is required as well:
    // the runner memoizes its outcome in a WeakMap keyed on the handle.
    for (const tag of [STATUS_TAG, SENTINEL_TAG]) {
      client.run("DELETE FROM __backlex_migrations WHERE name = ?", [tag]);
    }
    const second = await ensureMigrations(drizzleBunSqlite({ client }), "sqlite");

    // Re-executed (so the statements really did run again) and survived it.
    // This is the assertion that matters on Vercel/Netlify, where this runner
    // is the boot path: a migration that throws on a second pass is recorded
    // `failed` on every cold start of an already-migrated database.
    expect(second.applied).toContain(STATUS_TAG);
    expect(second.applied).toContain(SENTINEL_TAG);
    expect(second.failed).toEqual([]);

    // Exactly one of each column, and the rows written in between untouched.
    const cols = (
      client.query("PRAGMA table_info(tenants)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols.filter((n) => n === "status").length).toBe(1);
    expect(cols.filter((n) => n === "archived_at").length).toBe(1);
    expect(
      client.query("SELECT status FROM tenants WHERE id = 't-before'").get(),
    ).toEqual({ status: "active" });
    expect(
      client.query("SELECT tenant_id FROM app_settings WHERE id = 's-before'").get(),
    ).toEqual({ tenant_id: "_global" });
  });
});

// ---------------------------------------------------------------------------
// 4. The behaviour: an archived workspace is not distinguishable from one you
//    cannot have.
// ---------------------------------------------------------------------------

describe("a non-active workspace resolves like one the caller cannot have", () => {
  let cast: TwoPlaneCast;

  /** Strips the workspace key out of the refusal so two refusals that name
   *  DIFFERENT keys can still be compared for shape. Only used where the keys
   *  genuinely differ; the central comparison below uses the same key on both
   *  sides and needs no stripping at all. */
  const strip = (m: string) => m.replace(/"[^"]*"/, '"<key>"');

  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: { code: string; message: string } }).error;

  /** Flip a workspace's status by hand. The route that will do this for real is
   *  another agent's; what this spec is about is what the REQUEST PATH does
   *  once the column says a workspace is not live, so it writes the column
   *  directly and clears the per-isolate caches the way any status-changing
   *  route has to. Without that clear the middleware's `tenantResolveCache`
   *  would keep answering from a pre-archive entry for its 30 s TTL and this
   *  test would pass while proving nothing. */
  const setStatus = (tenantId: string, status: string): void => {
    const db = new Database(cast.h.env.SQLITE_PATH!);
    try {
      db.run("UPDATE tenants SET status = ? WHERE id = ?", [status, tenantId]);
      expect(
        db.query("SELECT status FROM tenants WHERE id = ?").get(tenantId),
      ).toEqual({ status });
    } finally {
      db.close();
    }
    invalidateAllPermissions();
  };

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
  });

  afterAll(() => cast.cleanup());

  test("archiving it makes a MEMBER's request answer byte-for-byte like a NON-member's", async () => {
    // Both sides name the SAME slug, so the two messages are directly
    // comparable with nothing stripped out. That is the point: if archiving
    // produced its own wording — or its own status code — the header would be
    // an oracle for "this workspace was suspended", which is exactly the fact
    // an operator suspending a tenant does not want broadcast to everyone who
    // can guess a slug.
    const header = { "X-Backlex-Tenant": cast.tenantB.slug };

    // Baseline first, while B is still live: ownerA is not a member of B.
    const outsider = await cast.ownerA.fetch("/api/collections", { headers: header });
    expect(outsider.status).toBe(404);
    const outsiderError = await errorOf(outsider);

    // Positive control — the same call from a MEMBER succeeds while B is
    // active. Without this the assertion below could be satisfied by a
    // middleware that refuses everyone, which is a different bug.
    const memberLive = await cast.ownerB.fetch("/api/collections", { headers: header });
    expect(memberLive.status).toBe(200);

    setStatus(cast.tenantB.id, "archived");

    const memberArchived = await cast.ownerB.fetch("/api/collections", {
      headers: header,
    });
    expect(memberArchived.status).toBe(outsider.status);
    expect(await errorOf(memberArchived)).toEqual(outsiderError);
  });

  test("suspended answers the same way archived does", async () => {
    // Two non-active values, one refusal. A reader that learned to refuse
    // `archived` by name rather than by "not active" would pass the test above
    // and fail this one.
    const header = { "X-Backlex-Tenant": cast.tenantB.slug };
    setStatus(cast.tenantB.id, "suspended");
    const res = await cast.ownerB.fetch("/api/collections", { headers: header });
    expect(res.status).toBe(404);
    const suspended = await errorOf(res);

    setStatus(cast.tenantB.id, "archived");
    const res2 = await cast.ownerB.fetch("/api/collections", { headers: header });
    expect(await errorOf(res2)).toEqual(suspended);
  });

  test("and like a workspace that does not exist at all", async () => {
    setStatus(cast.tenantB.id, "archived");
    const archived = await cast.ownerB.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": cast.tenantB.slug },
    });
    const missing = await cast.ownerB.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": `${cast.tenantB.slug}-definitely-not-real` },
    });
    expect(archived.status).toBe(missing.status);
    expect(archived.status).toBe(404);

    const a = await errorOf(archived);
    const m = await errorOf(missing);
    expect(a.code).toBe(m.code);
    // The keys differ here by construction, so compare the wording with the key
    // stripped. Everything else — code, status, phrasing — has to match.
    expect(strip(a.message)).toBe(strip(m.message));
  });

  test("the id spelling of the header is refused identically to the slug spelling", async () => {
    // `resolveTenantKey` short-circuits UUID-shaped keys without a lookup, so
    // the id path reaches the status gate through `resolveTenantAccess` rather
    // than through the slug resolver. Two code paths, one answer — and this is
    // the test that fails if only one of them learns about `status`.
    setStatus(cast.tenantB.id, "archived");
    const byId = await cast.ownerB.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": cast.tenantB.id },
    });
    const bySlug = await cast.ownerB.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": cast.tenantB.slug },
    });
    expect(byId.status).toBe(404);
    expect(byId.status).toBe(bySlug.status);
    expect(strip((await errorOf(byId)).message)).toBe(
      strip((await errorOf(bySlug)).message),
    );
  });

  test("restoring it to 'active' brings it straight back", async () => {
    // The refusal is never cached, so un-archiving is felt on the very next
    // request. This also closes the vacuous-pass door on every assertion above:
    // if the middleware had simply started refusing `X-Backlex-Tenant` outright
    // they would all still be green, and this one would not.
    setStatus(cast.tenantB.id, "archived");
    expect(
      (
        await cast.ownerB.fetch("/api/collections", {
          headers: { "X-Backlex-Tenant": cast.tenantB.slug },
        })
      ).status,
    ).toBe(404);

    setStatus(cast.tenantB.id, "active");
    expect(
      (
        await cast.ownerB.fetch("/api/collections", {
          headers: { "X-Backlex-Tenant": cast.tenantB.slug },
        })
      ).status,
    ).toBe(200);
  });

  test("an archived workspace does not take its neighbours down with it", async () => {
    // The gate is per-workspace, so A stays reachable while B is archived. A
    // predicate accidentally written against the wrong table (or a cache
    // cleared too broadly) shows up here and nowhere else.
    setStatus(cast.tenantB.id, "archived");
    const res = await cast.ownerA.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": cast.tenantA.slug },
    });
    expect(res.status).toBe(200);
    setStatus(cast.tenantB.id, "active");
  });
});

// ---------------------------------------------------------------------------
// 5. The same statements against a real Postgres parser
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
        "[workspace-status] pglite could not boot, so the pg half of this spec " +
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
      "[workspace-status] pg half skipped — pglite unavailable here:",
      setupErr.message.slice(0, 200),
    );
  }
});

describe("both migrations — migrated pg", () => {
  test("status back-fills to 'active', the sentinel collapses, and a replay changes nothing", async () => {
    // Only reachable under `BACKLEX_PG_TESTS=optional`; otherwise `beforeAll`
    // has already failed loudly.
    if (!pgliteWorks) return;
    const { PGlite } = await import("@electric-sql/pglite");
    // No pgvector and no full bundle: this spec is about four statements
    // against two tables, so it builds those tables from the baseline that
    // created them and applies the new files on top. Raw `exec` (simple
    // protocol) throughout, like every other pglite caller in this suite.
    const pg = new PGlite();
    await pg.waitReady;
    try {
      for (const table of ["tenants", "app_settings"]) {
        for (const stmt of baselineFor("pg", PG_BASELINE, table)) await pg.exec(stmt);
      }

      // Rows that predate both migrations, exactly like a live deployment's.
      await pg.exec(
        `INSERT INTO tenants (id, slug, name) VALUES ('t-legacy', 'legacy', 'Legacy')`,
      );
      const setting = (id: string, tenant: string, key: string, secs: number) =>
        pg.exec(
          `INSERT INTO app_settings (id, tenant_id, key, value, updated_at)
             VALUES ('${id}', ${tenant}, '${key}', '{}'::jsonb, to_timestamp(${secs}))`,
        );
      await setting("g-old", "'_global'", "branding", 200);
      await setting("n-oldest", "NULL", "branding", 100);
      await setting("n-newest", "NULL", "branding", 300);
      await setting("t-a", "'tenant-a'", "branding", 100);

      // Same measurement as the SQLite half: Postgres also treats NULLs as
      // DISTINCT in a UNIQUE index, so the two NULL rows above coexisted
      // without complaint. The engines AGREE here — it is worth pinning,
      // because "the dialects differ on NULL uniqueness" is a plausible-sounding
      // belief that would have justified a SQLite-only de-duplication.
      expect(
        (await pg.query(`SELECT count(*)::int AS n FROM app_settings WHERE tenant_id IS NULL`))
          .rows,
      ).toEqual([{ n: 2 }]);

      for (const stmt of statements(migrationSql("pg", STATUS_TAG))) await pg.exec(stmt);
      for (const stmt of statements(migrationSql("pg", SENTINEL_TAG))) await pg.exec(stmt);

      // The pre-existing workspace is live, and was never touched by an UPDATE:
      // Postgres filled it in as part of ADD COLUMN.
      expect(
        (await pg.query(`SELECT status, archived_at FROM tenants WHERE id = 't-legacy'`)).rows,
      ).toEqual([{ status: "active", archived_at: null }]);
      expect(
        (
          await pg.query(
            `SELECT is_nullable, column_default FROM information_schema.columns
              WHERE table_name = 'tenants' AND column_name = 'status'`,
          )
        ).rows,
      ).toEqual([{ is_nullable: "NO", column_default: "'active'::text" }]);
      expect(
        (
          await pg.query(
            `SELECT is_nullable, column_default FROM information_schema.columns
              WHERE table_name = 'tenants' AND column_name = 'archived_at'`,
          )
        ).rows,
      ).toEqual([{ is_nullable: "YES", column_default: null }]);

      const settings = async () =>
        (
          await pg.query(
            "SELECT id, tenant_id, key FROM app_settings ORDER BY id",
          )
        ).rows;
      // Newest wins across both spellings; the per-tenant row is the control.
      expect(await settings()).toEqual([
        { id: "n-newest", tenant_id: "_global", key: "branding" },
        { id: "t-a", tenant_id: "tenant-a", key: "branding" },
      ]);

      // Replay. `ADD COLUMN IF NOT EXISTS` means Postgres does not even raise
      // on the ALTERs, and the sentinel statements simply match nothing.
      for (const stmt of statements(migrationSql("pg", STATUS_TAG))) await pg.exec(stmt);
      for (const stmt of statements(migrationSql("pg", SENTINEL_TAG))) await pg.exec(stmt);
      expect(await settings()).toEqual([
        { id: "n-newest", tenant_id: "_global", key: "branding" },
        { id: "t-a", tenant_id: "tenant-a", key: "branding" },
      ]);
      expect(
        (
          await pg.query(
            `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'tenants' AND column_name IN ('status', 'archived_at')`,
          )
        ).rows,
      ).toEqual([{ n: 2 }]);
      expect(
        (await pg.query(`SELECT status FROM tenants WHERE id = 't-legacy'`)).rows,
      ).toEqual([{ status: "active" }]);
    } finally {
      await pg.close();
    }
  }, PGLITE_BOOT_TIMEOUT_MS);
});
