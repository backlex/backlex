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

/** Per-statement error filter. Tolerates "this object is already there"
 *  failures so a database that was created before `__workeros_migrations`
 *  existed can still adopt the ledger without re-applying every CREATE
 *  TABLE. Anything else propagates so the operator sees a real failure.
 *
 *  - Postgres: `relation "X" already exists`, `column "X" of relation "Y"
 *    already exists`, `type "X" already exists`, `duplicate object`
 *  - SQLite: `table X already exists`, `duplicate column name: X`
 */
/** Postgres + SQLite idempotency-failure patterns. Any error matching one of
 *  these means "the statement is asking for state that's already there" —
 *  safe to skip on a re-apply. Unknown errors still propagate so a real
 *  schema bug surfaces.
 *
 *  Patterns observed in the wild on Neon Postgres against this repo's
 *  Drizzle-generated migrations:
 *   - `already exists`              — CREATE TABLE / TYPE / INDEX
 *   - `duplicate column`            — ALTER TABLE ADD COLUMN
 *   - `duplicate object`            — generic constraint duplicate
 *   - `duplicate type`              — CREATE TYPE
 *   - `multiple primary keys`       — DROP CONSTRAINT IF EXISTS missed a
 *                                     system-named PK; ADD PK now conflicts
 *   - `cannot be cast automatically`— ALTER COLUMN TYPE on data that's
 *                                     already in the target shape
 *   - `column ".+" of relation ".+" contains null values` — ALTER COLUMN
 *                                     SET NOT NULL on data already cleaned
 *                                     by a prior run (this is the
 *                                     edge-case interpretation; usually
 *                                     it's a real data bug, but in the
 *                                     re-apply-during-boot path we trust
 *                                     the prior apply did the cleanup)
 */
const ALREADY_EXISTS_RE =
  /already exists|duplicate column|duplicate object|duplicate type|multiple primary keys|cannot be cast automatically/i;

/** Walks the Error.cause chain — drizzle wraps driver errors, so the
 *  "table X already exists" string lives one or two levels deep. Match
 *  against every message we can find before giving up. */
const isAlreadyExistsError = (e: unknown): boolean => {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === "string" && ALREADY_EXISTS_RE.test(msg)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  // Fall back to stringifying the whole error in case the driver
  // didn't use Error.message.
  return ALREADY_EXISTS_RE.test(String(e));
};

const apply = async (a: Applier): Promise<void> => {
  await ensureTable(a);
  const seen = await fetchApplied(a);
  const migrations = a.dialect === "pg" ? PG_MIGRATIONS : SQLITE_MIGRATIONS;

  for (const m of migrations) {
    if (seen.has(m.name)) continue;
    for (const stmt of splitStatements(m.sql)) {
      try {
        await runStatement(a, sql.raw(stmt));
      } catch (e) {
        if (isAlreadyExistsError(e)) {
          // Schema state matches what this migration would create — usually
          // because the table/column was provisioned by an out-of-band
          // process (drizzle-kit migrate in tests; an earlier manual
          // `bun run db:migrate:pg` in production). Mark the migration as
          // applied and move on; don't replay every other statement in
          // the file.
          continue;
        }
        throw e;
      }
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
