/**
 * SQL for the `__drizzle_migrations` ledger, kept in a side-effect-free module
 * so it can be executed against a real SQLite database in a test.
 *
 * `compact-d1-ledger.ts` is a script — importing it runs it — and the risky
 * part of that script is not its plumbing but these four statements. Splitting
 * them out is what lets `packages/db/tests/ledger-compaction.test.ts` prove the
 * dedupe keeps exactly one row per hash, keeps the *earliest* one, and that the
 * guard then rejects a duplicate insert.
 */

/** Name of the UNIQUE index that makes regrowth impossible. */
export const LEDGER_GUARD_INDEX = "__drizzle_migrations_hash_unique";

/**
 * Read statements go to wrangler as `--command=`, and no argv element may
 * contain a space: on the Cloudflare runner a spaced element arrived split
 * into four tokens (`Unknown arguments: hash, FROM, __drizzle_migrations;`).
 * `/**\/` is a comment SQLite treats as whitespace, so the statement stays one
 * token. Pinned by `apps/web/tests/migrate-d1-ledger.test.ts`.
 */
export const LEDGER_COUNT_SQL =
  `SELECT/**/COUNT(*)/**/AS/**/total,COUNT(DISTINCT/**/hash)/**/AS/**/hashes/**/FROM/**/__drizzle_migrations;`;

export const LEDGER_INDEX_LIST_SQL =
  `SELECT/**/name/**/FROM/**/sqlite_master/**/WHERE/**/type='index'/**/AND/**/tbl_name='__drizzle_migrations';`;

/**
 * Collapse the ledger to one row per hash.
 *
 * A single statement, so it is atomic without an explicit transaction — D1 does
 * not expose BEGIN/COMMIT over wrangler, and does not need to for this.
 *
 * Ranked by `created_at` then `id` rather than by `MIN(id)` alone. The two
 * agree today because drizzle appends in order, but the property being
 * preserved is "the earliest recording of this migration", so the SQL says
 * that instead of relying on a coincidence of insertion order.
 */
export const LEDGER_DEDUPE_SQL = `DELETE FROM __drizzle_migrations
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY hash ORDER BY created_at ASC, id ASC) AS rn
    FROM __drizzle_migrations
  ) WHERE rn = 1
);`;

/**
 * The guard. Run only after the dedupe — on a table that still holds
 * duplicates this fails, correctly but unhelpfully.
 *
 * `migrate-d1.ts` reports a failed ledger INSERT and continues rather than
 * aborting, so this cannot fail a deploy that would otherwise have succeeded.
 * What it does is make the old failure stop compounding: if the ledger read
 * breaks again, migrations replay and say so, but the table no longer grows by
 * a full set of rows each time — which is what turned one bad read into 34,811
 * rows and 15 of every 16 build minutes.
 */
export const LEDGER_GUARD_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS ${LEDGER_GUARD_INDEX} ON __drizzle_migrations (hash);`;

/** The table as `migrate-d1.ts` bootstraps it — mirrored here for tests. */
export const LEDGER_CREATE_SQL = `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  created_at INTEGER
);`;
