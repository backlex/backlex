/**
 * Boot-time migration runner. Idempotent + dedup'd per-isolate, so the very
 * first request after a fresh Postgres deploy applies every migration the
 * deployed bundle knows about, then short-circuits on every subsequent call.
 *
 * Why this exists: Vercel and Netlify don't ship a CI step that runs
 * `bun run db:migrate:pg` against the production database — every deploy
 * just uploads the function bundle. The schema is therefore frozen at
 * whatever the database was when first provisioned. Without this runner,
 * a feature like `mcp_tools` (added in 20260525010000_api_keys_mcp_metadata)
 * never reaches prod and Drizzle 500s on `SELECT *` from `api_keys`.
 *
 * Cloudflare D1 stays out of scope: `wrangler d1 migrations apply` runs
 * inside the Workers Build command, so D1 is already current before the
 * worker boots. Bun self-host runs migrations through the CLI explicitly.
 */
import { sql, type SQL } from "drizzle-orm";
import { MIGRATIONS as PG_MIGRATIONS } from "./pg/migrations-bundle";
import { MIGRATIONS as SQLITE_MIGRATIONS } from "./sqlite/migrations-bundle";

/**
 * Driver-API surface we need at runtime. Drizzle's two SQL dialects
 * expose different method shapes:
 *
 *   postgres-js / neon-http (pg)    → `db.execute(sql)` for both DDL + SELECT
 *   bun-sqlite / d1 (sqlite)        → `db.run(sql)` for DDL, `db.all(sql)` for SELECT
 *
 * We accept the union and pick the right method at call time.
 */
export type AutoMigrateDb = {
  execute?(query: SQL): Promise<unknown>;
  run?(query: SQL): Promise<unknown> | unknown;
  all?(query: SQL): Promise<unknown[]> | unknown[];
};

interface Applier {
  dialect: "pg" | "sqlite";
  db: AutoMigrateDb;
}

const runStatement = async (a: Applier, query: SQL): Promise<void> => {
  if (a.dialect === "pg") {
    if (!a.db.execute) throw new Error("pg db handle missing execute()");
    await a.db.execute(query);
  } else {
    if (!a.db.run) throw new Error("sqlite db handle missing run()");
    await a.db.run(query);
  }
};

const selectRows = async <T>(a: Applier, query: SQL): Promise<T[]> => {
  if (a.dialect === "pg") {
    if (!a.db.execute) throw new Error("pg db handle missing execute()");
    const r = (await a.db.execute(query)) as { rows?: T[] } | T[];
    return Array.isArray(r) ? r : r.rows ?? [];
  }
  if (!a.db.all) throw new Error("sqlite db handle missing all()");
  const rows = await a.db.all(query);
  return rows as T[];
};

/** Per-isolate cache. Keyed on the db handle so two requests in the same
 *  isolate dedupe but a fresh isolate (or a fresh test harness) runs the
 *  apply path. Promises live forever once stored — re-running migrations
 *  on the same handle is a no-op anyway. */
const applied = new WeakMap<object, Promise<void>>();

/** Split a migration's SQL by the drizzle-kit `--> statement-breakpoint`
 *  separator. Each statement runs in its own round-trip so a single
 *  syntactically-bad migration can't poison the rest of the apply. */
const splitStatements = (sqlText: string): string[] =>
  sqlText
    .split(/-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const ensureTable = async (a: Applier): Promise<void> => {
  if (a.dialect === "pg") {
    await runStatement(
      a,
      sql`CREATE TABLE IF NOT EXISTS __workeros_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`,
    );
  } else {
    await runStatement(
      a,
      sql`CREATE TABLE IF NOT EXISTS __workeros_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
      )`,
    );
  }
};

const fetchApplied = async (a: Applier): Promise<Set<string>> => {
  const rows = await selectRows<{ name: string }>(
    a,
    sql`SELECT name FROM __workeros_migrations`,
  );
  return new Set(rows.map((r) => r.name));
};

/** Tests + locally-migrated environments already have every table at the
 *  current schema — they just don't carry `__workeros_migrations` entries.
 *  If we naively run every migration in the bundle on first boot we'd hit
 *  "relation already exists" errors. To stay safe: when the migrations
 *  table is empty AND a core workeros table (`users`) already exists,
 *  assume the database is already at HEAD and back-fill the ledger with
 *  every migration in the bundle without executing any of them.
 *
 *  This is the "adopt the existing schema" path. A truly fresh database
 *  has no `users` table yet, so it falls through to the apply loop and
 *  runs every migration from scratch. Either way the ledger ends up
 *  matching the schema on disk. */
const detectAlreadyMigrated = async (a: Applier): Promise<boolean> => {
  try {
    if (a.dialect === "pg") {
      const rows = await selectRows<{ exists: boolean }>(
        a,
        sql`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') AS exists`,
      );
      return Boolean(rows[0]?.exists);
    }
    const rows = await selectRows<{ name: string }>(
      a,
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
};

const apply = async (a: Applier): Promise<void> => {
  await ensureTable(a);
  const seen = await fetchApplied(a);
  const migrations = a.dialect === "pg" ? PG_MIGRATIONS : SQLITE_MIGRATIONS;

  // Adopt-existing-schema bypass — see `detectAlreadyMigrated`. Only fires
  // on the very first apply for this isolate (`seen.size === 0`); once
  // entries land in the ledger we always take the diff-only fast path.
  if (seen.size === 0 && (await detectAlreadyMigrated(a))) {
    for (const m of migrations) {
      await runStatement(
        a,
        sql`INSERT INTO __workeros_migrations (name) VALUES (${m.name})`,
      );
    }
    return;
  }

  for (const m of migrations) {
    if (seen.has(m.name)) continue;
    for (const stmt of splitStatements(m.sql)) {
      await runStatement(a, sql.raw(stmt));
    }
    await runStatement(
      a,
      sql`INSERT INTO __workeros_migrations (name) VALUES (${m.name})`,
    );
  }
};

/** Apply every migration the bundle carries that hasn't already been
 *  recorded in `__workeros_migrations`. Safe to call concurrently; the
 *  per-isolate WeakMap ensures only one apply runs at a time per handle.
 *
 *  Throws if the database is unreachable or any statement fails. The
 *  caller (context.ts) catches and downgrades to a warning so a single
 *  bad migration can't take the whole app down — the next request retries.
 */
export const ensureMigrations = (
  db: AutoMigrateDb,
  dialect: "pg" | "sqlite",
): Promise<void> => {
  let promise = applied.get(db as unknown as object);
  if (promise) return promise;
  promise = apply({ db, dialect });
  applied.set(db as unknown as object, promise);
  return promise;
};
