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
import {
  MIGRATION_TAGS_PG,
  MIGRATION_TAGS_SQLITE,
} from "./migrations-manifest.generated";
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

/** Outcome of an auto-migrate run. `failed` is non-empty when a migration hit
 *  an error the idempotency tolerance did NOT recognise — i.e. a genuine
 *  failure. The runner still resolves (boot continues), but the caller can
 *  surface `failed` loudly / report it instead of it being a buried warning. */
export interface MigrationOutcome {
  applied: string[];
  failed: Array<{ name: string; error: string }>;
  /** Migrations this run did not execute because a CLI ledger already
   *  records them. Non-empty exactly once per database: the run that adopts
   *  it. See {@link adoptCliLedger}. */
  adopted: string[];
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
const applied = new WeakMap<object, Promise<MigrationOutcome>>();

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
      sql`CREATE TABLE IF NOT EXISTS __backlex_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`,
    );
  } else {
    await runStatement(
      a,
      sql`CREATE TABLE IF NOT EXISTS __backlex_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
      )`,
    );
  }
};

const fetchApplied = async (a: Applier): Promise<Set<string>> => {
  const rows = await selectRows<{ name: string }>(
    a,
    sql`SELECT name FROM __backlex_migrations`,
  );
  return new Set(rows.map((r) => r.name));
};

/** Per-statement error filter. Tolerates "this object is already there"
 *  failures so a database that was created before `__backlex_migrations`
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
 *
 * Deliberately NOT tolerated (these can hide real schema/data corruption and
 * are surfaced as genuine failures instead):
 *   - `cannot be cast automatically` — a failed `ALTER COLUMN TYPE`; treating
 *     it as a no-op masks a column left in the wrong type.
 *   - `column ... contains null values` — a failed `SET NOT NULL`; almost
 *     always a real data bug, not an idempotent re-apply.
 */
const ALREADY_EXISTS_RE =
  /already exists|duplicate column|duplicate object|duplicate type|multiple primary keys/i;

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

/** Pull the deepest message in the Error.cause chain. Drizzle wraps the
 *  underlying driver error one or two levels deep; the wrapper's `.message`
 *  is a useless `Failed query: ...` template, and the actual Postgres error
 *  text lives further in. Surface the leaf message in warning logs so an
 *  operator can read what really failed without a debugger. */
const deepestMessage = (e: unknown): string => {
  let cur: unknown = e;
  let deepest = "(no message)";
  for (let depth = 0; cur && depth < 5; depth++) {
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) deepest = msg;
    cur = (cur as { cause?: unknown }).cause;
  }
  return deepest;
};

/**
 * Where the migration CLIs keep THEIR ledger.
 *
 * This runner records migration NAMES in `__backlex_migrations`; every CLI in
 * `packages/db/src/*` records file HASHES in `__drizzle_migrations` instead
 * (drizzle-orm's own migrator does the same for Postgres, under the `drizzle`
 * schema). Two ledgers, no overlap — so a database the CLI brought fully
 * current reads as completely unmigrated here, and the runner replays all 138
 * files. See {@link adoptCliLedger} for why that is not merely wasteful.
 */
const CLI_LEDGER_SELECT = {
  pg: sql`SELECT hash FROM drizzle.__drizzle_migrations`,
  sqlite: sql`SELECT hash FROM __drizzle_migrations`,
} as const;

/**
 * Statements that are NOT no-ops when replayed against a schema that already
 * has them.
 *
 * `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` are deliberately absent: those
 * raise an "already exists" the runner tolerates, which is the whole point of
 * {@link isAlreadyExistsError}. What is listed here changes rows or removes
 * objects, and re-running it against a current schema destroys work that
 * arrived after the migration did.
 *
 * Derived from the statement TEXT rather than a list of migration names, for
 * the reason a hand-written list of system tables covered 46 of 131 in the
 * phase-2 audit: a list stops being right the moment somebody adds a file.
 */
const TRANSFORM_RE =
  /^\s*(?:INSERT\s+INTO|INSERT\s+OR|UPDATE|DELETE\s+FROM|DROP\s+TABLE)\b|\bRENAME\s+TO\b|\bRENAME\s+COLUMN\b|\bDROP\s+COLUMN\b/i;

/**
 * Would replaying this ONE statement against a schema that already has it
 * change something?
 *
 * EXPORTED so the spec can drive each alternative directly. That is not a
 * convenience: three of the alternatives (`RENAME TO`, `RENAME COLUMN`,
 * `DROP COLUMN`) match no statement in today's bundle, because every file that
 * renames also drops or inserts. Verified by breaking, `RENAME TO` could be
 * deleted from the regex with the whole suite still green — a rule that reads
 * as load-bearing and is not. Phase 7 met the same shape and DELETED the rule;
 * this one is kept instead, because a standalone `ALTER TABLE … RENAME TO …`
 * is a migration somebody will write and its replay renames the wrong table.
 * Keeping it is only defensible if it is exercised, so it is.
 */
export const isTransformStatement = (statement: string): boolean =>
  TRANSFORM_RE.test(statement);

const hasTransform = (statements: readonly string[]): boolean =>
  statements.some(isTransformStatement);

/**
 * Record every migration a CLI ledger already vouches for, so this runner does
 * not replay it.
 *
 * WHAT WAS WRONG
 *
 * The documented self-host path is `bun run db:migrate:sqlite`, which applies
 * every file and records 138 hashes in `__drizzle_migrations`. The first
 * request then reaches `context.ts`, which calls `ensureMigrations` on every
 * target that is not D1 — including that self-host — and `__backlex_migrations`
 * is empty, so the whole bundle replays. Reproduced end to end against a real
 * SQLite file: `applied: 138, failed: 0`, and an adopted collection carrying
 * `adopted=1, icon='star', hidden=1, group_name='Content'` came back out as
 * `adopted=0, icon=null, hidden=0, group_name=null`.
 *
 * The mechanism is worth stating precisely, because "already exists" tolerance
 * is what made it silent. `20260510120000_per_workspace_collections` cannot
 * ALTER a SQLite primary key, so it rebuilds the table: create `__new_collections`
 * with the 14 columns of that era, copy, `DROP TABLE collections`, rename. On a
 * replay its first statement (`ADD COLUMN id`) raises `duplicate column name`,
 * which the runner correctly skips — and then runs the rebuild anyway, against a
 * table that by then has 40 columns. The 26 columns added by later migrations
 * are dropped with the old table and re-created, at their DEFAULTS, by those
 * same later migrations replaying behind it. Nothing errors. `adopted` reset to
 * `0` means backlex now believes it owns a table the operator merely wrapped.
 *
 * WHY MATCHING ON HASHES AND NOT ON NAMES
 *
 * The CLI ledger stores only the sha256 of the file, but
 * `migrations-manifest.generated.ts` already maps hash → folder tag for both
 * dialects (it exists so the admin Migrations page can show tags), and
 * `scripts/build-manifest.ts` hashes exactly the way drizzle-orm's migrator and
 * both CLIs do. So the mapping is free and it is the same function the writers
 * used.
 *
 * A consequence worth writing down: **the SQL of a released migration is now
 * immutable.** Editing one changes its hash, which un-maps every ledger row a
 * production database already holds — the CLI would re-run the file and so
 * would this. That is why the destructive rebuild above is NOT fixed by editing
 * its SQL, which is what the audit finding proposed; the guard below covers it
 * from the runner side instead.
 *
 * Runs on every invocation rather than only when the ledger is empty, so a
 * self-host that keeps using the CLI stays converged for FUTURE migrations too.
 * The read is one indexed scan of a table with as many rows as migrations.
 */
const adoptCliLedger = async (
  a: Applier,
  seen: Set<string>,
  bundled: ReadonlySet<string>,
): Promise<string[]> => {
  let hashes: string[];
  try {
    const rows = await selectRows<{ hash: unknown }>(a, CLI_LEDGER_SELECT[a.dialect]);
    hashes = rows.map((r) => r.hash).filter((h): h is string => typeof h === "string");
  } catch {
    // No CLI ledger. The ordinary case for a database this runner provisioned
    // itself (Vercel / Netlify Postgres), and not a problem — there is simply
    // nothing to adopt.
    return [];
  }
  const tags = a.dialect === "pg" ? MIGRATION_TAGS_PG : MIGRATION_TAGS_SQLITE;
  const adopted: string[] = [];
  for (const hash of new Set(hashes)) {
    const name = tags[hash];
    // Unknown hash: a migration this bundle does not carry (the database is
    // ahead of the deployed code) or a file edited since it was applied.
    // Either way there is nothing here to claim as done.
    if (!name || seen.has(name) || !bundled.has(name)) continue;
    // Conflict-tolerant, because `seen` was read before this loop began and two
    // isolates can boot at once: without it, the second one's INSERT hits the
    // PRIMARY KEY and throws out of `apply` entirely, leaving that process with
    // NO migrations applied. A name already in the ledger is the outcome this
    // statement wanted anyway.
    await runStatement(
      a,
      a.dialect === "pg"
        ? sql`INSERT INTO __backlex_migrations (name) VALUES (${name}) ON CONFLICT DO NOTHING`
        : sql`INSERT OR IGNORE INTO __backlex_migrations (name) VALUES (${name})`,
    );
    seen.add(name);
    adopted.push(name);
  }
  return adopted;
};

const apply = async (a: Applier): Promise<MigrationOutcome> => {
  await ensureTable(a);
  const seen = await fetchApplied(a);
  const migrations = a.dialect === "pg" ? PG_MIGRATIONS : SQLITE_MIGRATIONS;
  const outcome: MigrationOutcome = { applied: [], failed: [], adopted: [] };
  // Before deciding what to run: believe the other ledger. A database a CLI
  // already brought current must not be replayed into.
  outcome.adopted = await adoptCliLedger(
    a,
    seen,
    new Set(migrations.map((m) => m.name)),
  );

  for (const m of migrations) {
    if (seen.has(m.name)) continue;
    // Per-migration try/catch: one stuck migration must not abort the rest
    // of the bundle. Before this guard, a non-idempotent failure in
    // migration N left N+1..N+k unapplied AND the ledger stale, forcing
    // a manual recovery (we hit this on Neon-Postgres production with
    // migration #13 of 37, where the auto-migrate ledger stuck at 12).
    //
    // Per-statement idempotency tolerance still runs INSIDE this block
    // (every "already exists"-style error is skipped silently). Anything
    // it doesn't recognise — typically a driver- or DB-specific error
    // shape we haven't yet learned to classify — gets caught here, the
    // migration is skipped with a warning, and the loop continues. The
    // ledger row is NOT inserted so the next cold start retries this
    // migration in isolation.
    const statements = splitStatements(m.sql);
    // A file that only creates things is safe to replay statement by statement:
    // every "already exists" is genuinely a no-op. A file that also TRANSFORMS
    // is not, and the two have to be told apart before the first error, not
    // after — see `TRANSFORM_RE` and {@link adoptCliLedger}.
    const transforms = hasTransform(statements);
    try {
      for (const stmt of statements) {
        try {
          await runStatement(a, sql.raw(stmt));
        } catch (e) {
          if (isAlreadyExistsError(e) && transforms) {
            // The object this statement creates is already there, so the file
            // has run before — and it carries statements that would rewrite or
            // drop data if the rest of it ran now. Refuse, and refuse LOUDLY:
            // the ledger row is deliberately not written, so the operator is
            // told on every boot until the ledger is repaired, and no partial
            // replay is passed off as a completed one.
            throw new Error(
              `migration is already applied ("${deepestMessage(e)}") but the file also ` +
                `transforms data, so replaying the rest of it would rewrite rows that ` +
                `arrived after it. Refusing. Record it instead — ` +
                `INSERT INTO __backlex_migrations (name) VALUES ('${m.name}') — or run ` +
                `\`bun run db:migrate:${a.dialect}\` so the CLI ledger this runner adopts is present.`,
            );
          }
          if (isAlreadyExistsError(e)) {
            // Schema state matches what this migration would create —
            // usually because the table/column was provisioned by an
            // out-of-band process (drizzle-kit migrate in tests; an
            // earlier manual `bun run db:migrate:pg` in production).
            // Mark the statement as effectively applied and move on;
            // don't replay every other statement in the file.
            continue;
          }
          throw e;
        }
      }
      await runStatement(
        a,
        sql`INSERT INTO __backlex_migrations (name) VALUES (${m.name})`,
      );
      outcome.applied.push(m.name);
    } catch (e) {
      // A genuine failure — the idempotency tolerance did NOT recognise this
      // error. Surface the deepest cause-chain message (drizzle wraps the real
      // driver/DB error in a useless "Failed query" template). The ledger row
      // is NOT inserted, so the next cold start retries this migration in
      // isolation; meanwhile it's recorded in `failed` so the caller can alert
      // instead of it being a buried warning that boots green on a bad schema.
      const error = deepestMessage(e);
      console.warn(`[auto-migrate] migration "${m.name}" FAILED: ${error}`);
      outcome.failed.push({ name: m.name, error });
    }
  }
  return outcome;
};

/** Apply every migration the bundle carries that hasn't already been
 *  recorded in `__backlex_migrations`. Safe to call concurrently; the
 *  per-isolate WeakMap ensures only one apply runs at a time per handle.
 *
 *  Resolves with a {@link MigrationOutcome}. It throws only if the database is
 *  unreachable or the ledger table can't be created; a single bad *migration*
 *  is captured in `outcome.failed` (boot continues) so the caller can alert
 *  loudly instead of every endpoint 500ing. The caller (context.ts) inspects
 *  `failed` and reports it.
 */
export const ensureMigrations = (
  db: AutoMigrateDb,
  dialect: "pg" | "sqlite",
): Promise<MigrationOutcome> => {
  let promise = applied.get(db as unknown as object);
  if (promise) return promise;
  promise = apply({ db, dialect });
  applied.set(db as unknown as object, promise);
  return promise;
};
