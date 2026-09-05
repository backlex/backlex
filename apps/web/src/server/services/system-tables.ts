/**
 * Which physical tables a workspace is allowed to point a collection at.
 *
 * Adoption registers a `collections` row against a table backlex did not
 * create, and `/api/items/:slug` then reads that table with the collection's
 * permissions rather than the table's. So the question "may this workspace
 * name this table?" is the whole of the boundary — every write door that can
 * set `collections.physical_table` has to ask it, and so does the read path,
 * because a row written before this existed is still a row.
 *
 * ## Why the set is derived rather than listed
 *
 * `services/adopt.ts` used to carry a hand-written `SYSTEM_TABLES` set. It had
 * 46 entries against a schema of 131 tables, so **91 system tables were
 * invisible to it** — `signing_keys` (private keys), `oauth_access_tokens`,
 * `ai_config` / `payment_providers` / `integrations` (provider credentials),
 * `twoFactor` (TOTP secrets), `s3_credentials`, `impersonations`. The list was
 * not wrong when it was written; it simply stopped being read every time a
 * feature added a table, which is what a hand-maintained blocklist does. See
 * [[guard-exception-lists-launder-defects]].
 *
 * Reading the names off the Drizzle schema removes the maintenance step
 * entirely: a table that exists is a table that is covered, on the commit that
 * adds it. `tests/security-audit-2026-09-adoption-blocklist.test.ts` asserts the
 * derivation still sees every table, so a drizzle upgrade that breaks `is()`
 * fails loudly instead of quietly returning an empty set.
 *
 * Both dialects are unioned. They are in lockstep today (131 = 131, verified),
 * and the union means a future divergence is covered on whichever side gains
 * the table — never the narrower of the two.
 */
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { tenantTablePrefix } from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";

/**
 * Case-fold a table name for comparison.
 *
 * **This is load-bearing, not tidiness.** SQLite — so D1, so the Cloudflare
 * deploy — resolves table identifiers case-INSENSITIVELY: `SELECT * FROM
 * "Sessions"` reads `sessions`. A case-sensitive `Set.has()` therefore answers
 * "not a system table" for a name the engine happily resolves to one, and every
 * check in this module would be bypassed by capitalising one letter.
 *
 * `POST /api/collections` is incidentally safe because `assertIdent` refuses
 * anything outside `[a-z_][a-z0-9_]*` before the guard runs. The other three
 * write doors — snapshot apply, backup restore, `/adopt/inspect` — never call
 * it, so the fold is what actually covers them.
 *
 * `toLowerCase`, never `toLocaleLowerCase`: the latter maps `I` to `ı` under a
 * Turkish locale, which would make a name fail to match itself. See
 * [[js-fold-vs-db-fold]].
 *
 * Both sides are folded, because the schema really does contain a camelCase SQL
 * name (`twoFactor`, from better-auth) — folding only the input would stop
 * matching it.
 */
const fold = (table: string): string => table.toLowerCase();

const collectNames = (): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const v of Object.values(pg.schema)) {
    if (is(v, PgTable)) names.add(fold(getTableName(v)));
  }
  for (const v of Object.values(sqlite.schema)) {
    if (is(v, SQLiteTable)) names.add(fold(getTableName(v)));
  }
  return names;
};

/**
 * Every table backlex owns, read off the Drizzle schema for both dialects.
 *
 * Computed once at module load — 131 `is()` calls, well inside the worker's
 * startup budget ([[worker-startup-cpu-budget]]). Deliberately NOT exported
 * from `@backlex/db`'s index: that entry point keeps the schemas out of its
 * graph on purpose (see the comment above its type-only migration re-export),
 * and ~80 files import it.
 */
export const SYSTEM_TABLE_NAMES: ReadonlySet<string> = collectNames();

/**
 * backlex tables the Drizzle schema no longer declares but every deployed
 * database still has, because no migration drops them.
 *
 * The derivation above is the right default and covers all 131 — but it answers
 * "what does the schema declare today", and a table that was superseded is
 * still a table full of rows. This list is deliberately tiny,
 * and the adoption test asserts every entry is absent from the schema, so a
 * name that ever rejoins it has to be deleted from here rather than sit as a
 * second, drifting copy.
 *
 * - `embeddings` — the single-table vector store, created by
 *   `20260503204108_nappy_ares` (sqlite) / `20260504034557_quick_northstar`
 *   (pg) and superseded by the per-model `embeddings_*` tables in
 *   `20260702130000_embeddings_per_model`. Never dropped, and it holds the
 *   `content` that was vectorized — i.e. collection text, for every workspace.
 *
 * (The old hand-written list also carried `activity_log`, which no migration
 * has ever created on either dialect. It was guarding nothing.)
 */
const LEGACY_TABLE_NAMES: ReadonlySet<string> = new Set(["embeddings"]);

/**
 * Names reserved for bookkeeping rather than data. Not in the Drizzle schema
 * because nothing in this repo declares them as tables — SQLite, Cloudflare D1,
 * drizzle-kit and `auto-migrate.ts` create them directly.
 *
 * `__` covers both migration ledgers (`__drizzle_migrations` from drizzle-kit,
 * `__backlex_migrations` from `packages/db/src/auto-migrate.ts`) and anything
 * later added under the same convention — the old list named the first and was
 * still offering the second. `_cf_*` is the one with teeth beyond disclosure:
 * probing it raises `SQLITE_AUTH`, so a collection over it 500s rather than
 * 403s.
 */
const ENGINE_PREFIXES = ["sqlite_", "_cf_", "d1_", "__"] as const;

/**
 * Why this workspace may not point a collection at `table`, or `null` when it
 * may.
 *
 * A reason string rather than a boolean so the refusal can say which rule it
 * hit — an admin who typed a legacy table name needs to tell "that is ours" and
 * "that belongs to another workspace" apart, and a log line that only says
 * `false` sends them to the source.
 */
export const reservedTableReason = (table: string, tenantId: string): string | null => {
  const shared = reservedNameReason(table);
  if (shared) return shared;
  // Managed collection tables are `c_<tenantPrefix12>_<slug>`. Another
  // workspace's is exactly the cross-tenant read this guard exists for, and a
  // legacy pre-tenant `c_<slug>` is already registered to whoever created it —
  // so on a door that is CHOOSING a binding, no `c_` name but this workspace's
  // own is a legitimate answer. The adopt picker has always hidden all of them.
  const name = fold(table);
  const mine = tenantTablePrefix(tenantId);
  if (name.startsWith("c_") && !(mine && name.startsWith(`c_${mine}_`))) {
    return `"${table}" is another workspace's collection table`;
  }
  return null;
};

/**
 * Why a collection that is ALREADY registered against `table` must not be
 * served, or `null` when it may be.
 *
 * Deliberately weaker than `reservedTableReason` on exactly one rule, and the
 * difference is not cosmetic. `20260510120000_per_workspace_collections` gave
 * every collection that predated per-workspace naming
 * `physical_table = 'c_' || slug` — **no tenant prefix** — and never renamed the
 * table. Those rows are live on every upgraded deployment. Refusing them here
 * would 403 every legacy collection in production, which is a worse outcome
 * than the hole this phase closes.
 *
 * So a prefixless `c_<slug>` is honoured, and only a name carrying someone
 * ELSE'S 12-hex prefix is refused — a shape `derivePhysicalTable` can only have
 * produced for another workspace. The write doors stay strict: choosing a new
 * binding to a legacy name is not something any flow needs.
 */
export const unreadableTableReason = (table: string, tenantId: string): string | null => {
  const shared = reservedNameReason(table);
  if (shared) return shared;
  const owner = /^c_([0-9a-f]{12})_/.exec(fold(table))?.[1];
  if (owner && owner !== tenantTablePrefix(tenantId)) {
    return `"${table}" is another workspace's collection table`;
  }
  return null;
};

/**
 * The tenant-independent half of `reservedTableReason` — everything that is off
 * limits to *every* workspace.
 *
 * Split out for the adopt picker, which enumerates tables without a collection
 * in hand and already hides every `c_*` name (its own workspace's included, so
 * the wizard offers only tables backlex did not create).
 */
export const reservedNameReason = (table: string): string | null => {
  const name = fold(table);
  if (SYSTEM_TABLE_NAMES.has(name) || LEGACY_TABLE_NAMES.has(name)) {
    return `"${table}" is a backlex system table`;
  }
  for (const prefix of ENGINE_PREFIXES) {
    if (name.startsWith(prefix)) {
      return `"${table}" is reserved for bookkeeping (${prefix}*)`;
    }
  }
  // The FTS shadow and translations sidecar belong to a collection, and are
  // read through it. Adopting one directly would serve its rows under a second
  // collection's permissions — the parent's field allow-list and row condition
  // would not be in the path at all.
  if (name.endsWith("__fts") || name.endsWith("__i18n")) {
    return `"${table}" is a collection's search/translation sidecar`;
  }
  return null;
};

/** Exported for the test that keeps `LEGACY_TABLE_NAMES` from rotting — it
 *  asserts every entry is genuinely absent from the schema, so a name that
 *  rejoins it has to be deleted here rather than sit as a second copy. Not
 *  part of the guard's surface. */
export const legacyTableNamesForTest = (): ReadonlySet<string> => LEGACY_TABLE_NAMES;
