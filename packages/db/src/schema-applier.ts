import { sql } from "drizzle-orm";
import type { PgDb } from "./pg";
import type { SqliteDb } from "./sqlite";
import {
  type FieldDef,
  columnDefSql,
  ftsTableName,
  quote,
  sqlTypeFor,
  validateFields,
} from "./field-types";

type Dialect = "pg" | "sqlite";
type AnyDb = PgDb | SqliteDb;

const exec = async (db: AnyDb, dialect: Dialect, raw: string): Promise<void> => {
  const q = sql.raw(raw);
  if (dialect === "pg") {
    await (db as PgDb).execute(q);
  } else {
    await (db as { run: (s: typeof q) => Promise<unknown> }).run(q);
  }
};

const all = async <T>(db: AnyDb, dialect: Dialect, raw: string): Promise<T[]> => {
  const q = sql.raw(raw);
  if (dialect === "pg") {
    const r = (await (db as PgDb).execute(q)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) {
      return (r as { rows: T[] }).rows;
    }
    return r as T[];
  }
  return (await (db as { all: (s: typeof q) => Promise<T[]> }).all(q)) as T[];
};

/** Storage type of the `id` column on a managed table. `uuid` is the
 *  historical default; `text`/`integer` exist so external-DB migration can
 *  preserve source primary keys verbatim (a bigint PK can't live in a PG
 *  `uuid` column). Only consulted at CREATE TABLE time — the applier never
 *  alters an existing PK column. */
export type PkType = "uuid" | "text" | "integer";

interface CollectionShape {
  /** Physical table name (e.g. `c_<tenantPrefix>_<slug>`). Caller is
   *  responsible for deriving and passing it; the applier never recomputes. */
  table: string;
  fields: FieldDef[];
  /** PK column storage type. Default `uuid`. See {@link PkType}. */
  pkType?: PkType;
  ownerScoped?: boolean;
  /** When true (default), the physical table gets a `tenant_id` column and
   *  reads/writes are scoped to the active tenant via the items router. */
  tenantScoped?: boolean;
  /** When true, the physical table gets `_status` + `_published_at` columns. */
  versioned?: boolean;
  /** Whether to create the `created_at` / `updated_at` columns. Default true.
   *  Managed collections may opt out (the items router gates reads/writes on
   *  the matching `has*` metadata flags). */
  hasCreatedAt?: boolean;
  hasUpdatedAt?: boolean;
  /** When true, the physical table gets a nullable `deleted_at` column so
   *  DELETE can soft-delete instead of removing the row. */
  softDelete?: boolean;
  /** When true, the physical table gains a keyword full-text-search index
   *  (Postgres: a `_fts` tsvector column + GIN; SQLite: a `<table>__fts`
   *  FTS5 shadow table) when at least one field is flagged `searchable`. The
   *  index content is maintained by the item-write hooks, not by the DB. */
  fts?: boolean;
  /** When true, the table is *adopted* (already exists, not managed by us).
   *  Apply is a no-op — we never DDL someone else's table. The collections
   *  metadata is the only thing that changes for adoptions. */
  adopted?: boolean;
}

/** Whether a field contributes to the full-text index — `searchable` and a
 *  text-like type. Mirrors the vectorize `text`/`longtext`-only rule. */
const isFtsField = (f: FieldDef): boolean =>
  Boolean(f.searchable) && (f.type === "text" || f.type === "longtext");

/**
 * Create the full-text-search index objects for a managed collection.
 * Idempotent and additive — safe to call on every `applyCollection`. No-op
 * unless the collection has `fts` enabled with at least one `searchable`
 * text/longtext field. Postgres keeps the index inline (a `_fts` tsvector
 * column + GIN); SQLite uses an FTS5 shadow table. The actual index *content*
 * is written by the item-write hooks (services/fts.ts), never here.
 */
const ensureFtsObjects = async (
  db: AnyDb,
  dialect: Dialect,
  table: string,
  fields: FieldDef[],
): Promise<void> => {
  if (!fields.some(isFtsField)) return;
  if (dialect === "pg") {
    const existing = await introspectColumns(db, dialect, table);
    if (!existing.has("_fts")) {
      await exec(
        db,
        dialect,
        `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("_fts")} tsvector`,
      );
    }
    await exec(
      db,
      dialect,
      `CREATE INDEX IF NOT EXISTS ${quote(`${table}_fts_idx`)} ON ${quote(table)} USING GIN (${quote("_fts")})`,
    );
    return;
  }
  // SQLite: a contentless-ish FTS5 shadow table keyed by the item id. `item_id`
  // is UNINDEXED (stored, not searched) so MATCH only scans `content`; bm25()
  // ranks. The write hook keeps it in sync (delete-then-insert per row).
  await exec(
    db,
    dialect,
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${quote(ftsTableName(table))} USING fts5(item_id UNINDEXED, content)`,
  );
};

const systemColumns = (
  dialect: Dialect,
  ownerScoped: boolean,
  versioned: boolean = false,
  tenantScoped: boolean = true,
  hasCreatedAt: boolean = true,
  hasUpdatedAt: boolean = true,
  softDelete: boolean = false,
  pkType: PkType = "uuid",
): string[] => {
  const ts = sqlTypeFor("timestamp", dialect);
  const cols = [
    `${quote("id")} ${sqlTypeFor(pkType, dialect)} PRIMARY KEY`,
    ...(tenantScoped ? [`${quote("tenant_id")} ${sqlTypeFor("text", dialect)}`] : []),
    ...(ownerScoped ? [`${quote("owner_id")} ${sqlTypeFor("text", dialect)}`] : []),
    ...(hasCreatedAt ? [`${quote("created_at")} ${ts} NOT NULL`] : []),
    ...(hasUpdatedAt ? [`${quote("updated_at")} ${ts} NOT NULL`] : []),
    ...(softDelete ? [`${quote("deleted_at")} ${ts}`] : []),
    ...(versioned
      ? [
          `${quote("_status")} ${sqlTypeFor("text", dialect)} NOT NULL DEFAULT 'draft'`,
          `${quote("_published_at")} ${ts}`,
          // Scheduled-publish time; the cron tick flips a draft → published once
          // `_publish_at <= now`. NULL = not scheduled.
          `${quote("_publish_at")} ${ts}`,
          // Scheduled-unpublish (expiry) time; the cron tick reverts a published
          // row → draft once `_unpublish_at <= now`. NULL = no expiry.
          `${quote("_unpublish_at")} ${ts}`,
        ]
      : []),
  ];
  return cols;
};

export const tableExists = async (
  db: AnyDb,
  dialect: Dialect,
  table: string,
): Promise<boolean> => {
  if (dialect === "pg") {
    const rows = await all<{ exists: boolean }>(
      db,
      dialect,
      `SELECT to_regclass('${table.replace(/'/g, "''")}') IS NOT NULL AS "exists"`,
    );
    return Boolean(rows[0]?.exists);
  }
  const rows = await all<{ name: string }>(
    db,
    dialect,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${table.replace(/'/g, "''")}'`,
  );
  return rows.length > 0;
};

export const introspectColumns = async (
  db: AnyDb,
  dialect: Dialect,
  table: string,
): Promise<Set<string>> => {
  if (dialect === "pg") {
    const rows = await all<{ column_name: string }>(
      db,
      dialect,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = '${table.replace(/'/g, "''")}'`,
    );
    return new Set(rows.map((r) => r.column_name));
  }
  const rows = await all<{ name: string }>(
    db,
    dialect,
    `PRAGMA table_info(${quote(table)})`,
  );
  return new Set(rows.map((r) => r.name));
};

/**
 * Idempotently ensure a *versioned* collection's system columns exist on its
 * physical table: `_status`, `_published_at`, `_publish_at` (+ their indexes).
 * Introspects first and only ALTERs what's missing, so it's cheap and safe to
 * call on the write path.
 *
 * This heals tables that were made versioned *before* `_publish_at` /
 * scheduled publishing existed and whose schema was never re-applied since.
 * publish / unpublish / schedule all write `_publish_at` unconditionally, so a
 * table missing that column 500s the request ("no such column: _publish_at")
 * even though the row still reads/writes fine everywhere else. `applyCollection`
 * already backfills these on a schema re-apply, but that only runs when an admin
 * edits the collection — the publish path can't assume it has.
 */
export const ensureVersionedColumns = async (
  db: AnyDb,
  dialect: Dialect,
  table: string,
): Promise<void> => {
  const existing = await introspectColumns(db, dialect, table);
  if (!existing.has("_status")) {
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("_status")} ${sqlTypeFor("text", dialect)} NOT NULL DEFAULT 'draft'`,
    );
    await exec(
      db,
      dialect,
      `CREATE INDEX IF NOT EXISTS ${quote(`${table}_status_idx`)} ON ${quote(table)} (${quote("_status")})`,
    );
  }
  if (!existing.has("_published_at")) {
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("_published_at")} ${sqlTypeFor("timestamp", dialect)}`,
    );
  }
  if (!existing.has("_publish_at")) {
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("_publish_at")} ${sqlTypeFor("timestamp", dialect)}`,
    );
    await exec(
      db,
      dialect,
      `CREATE INDEX IF NOT EXISTS ${quote(`${table}_publish_at_idx`)} ON ${quote(table)} (${quote("_publish_at")})`,
    );
  }
  if (!existing.has("_unpublish_at")) {
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("_unpublish_at")} ${sqlTypeFor("timestamp", dialect)}`,
    );
    await exec(
      db,
      dialect,
      `CREATE INDEX IF NOT EXISTS ${quote(`${table}_unpublish_at_idx`)} ON ${quote(table)} (${quote("_unpublish_at")})`,
    );
  }
};

/**
 * Emit a plain B-tree index for every field flagged `indexed`, plus every
 * to-one `relation` field — its FK column is what every `expand=`/nested
 * filter/sort JOINs on, and an un-indexed FK turns those into a full scan of
 * the child table per parent row. Idempotent (`CREATE INDEX IF NOT EXISTS` —
 * supported on both PG and SQLite) so it runs on create AND on every later
 * `applyCollection`, picking up fields that gained the flag (or relations
 * added) later. `unique` fields are skipped — the UNIQUE constraint already
 * provides an index. `relation_many` is skipped — it has no scalar FK column
 * (its links live in a JSON array / junction), so a plain index buys nothing.
 */
const ensureFieldIndexes = async (
  db: AnyDb,
  dialect: Dialect,
  table: string,
  fields: FieldDef[],
): Promise<void> => {
  for (const f of fields) {
    const wantIndex = f.indexed || f.type === "relation";
    if (!wantIndex || f.unique) continue;
    await exec(
      db,
      dialect,
      `CREATE INDEX IF NOT EXISTS ${quote(`${table}_${f.name}_idx`)} ON ${quote(table)} (${quote(f.name)})`,
    );
  }
};

/**
 * Composite index that backs the default list ordering (`-created_at`) and
 * keyset pagination's `(…, created_at, id)` seek. Leading with `tenant_id`
 * (when tenant-scoped) lets the planner seek the tenant partition and then
 * walk `created_at, id` in order — a plain ASC btree serves the `DESC` default
 * sort via a backward scan on both engines. No-op when the collection has no
 * `created_at` (the pk is already indexed, nothing left to compose).
 */
const ensurePaginationIndex = async (
  db: AnyDb,
  dialect: Dialect,
  table: string,
  opts: { tenantScoped: boolean; hasCreatedAt: boolean },
): Promise<void> => {
  if (!opts.hasCreatedAt) return;
  const cols = [
    ...(opts.tenantScoped ? [quote("tenant_id")] : []),
    quote("created_at"),
    quote("id"),
  ].join(", ");
  await exec(
    db,
    dialect,
    `CREATE INDEX IF NOT EXISTS ${quote(`${table}_keyset_idx`)} ON ${quote(table)} (${cols})`,
  );
};

/**
 * Idempotent: creates the physical table for a collection, or adds any
 * columns that aren't already present. Never drops columns; for that, use
 * `dropField` explicitly.
 */
export const applyCollection = async (
  db: AnyDb,
  dialect: Dialect,
  def: CollectionShape,
): Promise<void> => {
  // Adopted tables are the user's pre-existing tables — DDL on them is the
  // one thing the adopt flow exists *not* to do. The `collections` row is
  // the source of truth; ALTER/CREATE never runs here.
  if (def.adopted) return;
  validateFields(def.fields);
  const table = def.table;
  const ownerScoped = Boolean(def.ownerScoped);
  // Default to tenant-scoped: workspaces are the recommended posture and
  // collections that opt out must do so explicitly.
  const tenantScoped = def.tenantScoped !== false;
  const versioned = Boolean(def.versioned);
  const hasCreatedAt = def.hasCreatedAt !== false;
  const hasUpdatedAt = def.hasUpdatedAt !== false;
  const softDelete = Boolean(def.softDelete);

  if (!(await tableExists(db, dialect, table))) {
    const cols = [
      ...systemColumns(
        dialect,
        ownerScoped,
        versioned,
        tenantScoped,
        hasCreatedAt,
        hasUpdatedAt,
        softDelete,
        def.pkType ?? "uuid",
      ),
      ...def.fields.map((f) => columnDefSql(f, dialect)),
    ];
    await exec(
      db,
      dialect,
      `CREATE TABLE ${quote(table)} (${cols.join(", ")})`,
    );
    if (ownerScoped) {
      await exec(
        db,
        dialect,
        `CREATE INDEX ${quote(`${table}_owner_idx`)} ON ${quote(table)} (${quote("owner_id")})`,
      );
    }
    if (tenantScoped) {
      await exec(
        db,
        dialect,
        `CREATE INDEX ${quote(`${table}_tenant_idx`)} ON ${quote(table)} (${quote("tenant_id")})`,
      );
    }
    if (versioned) {
      await exec(
        db,
        dialect,
        `CREATE INDEX ${quote(`${table}_status_idx`)} ON ${quote(table)} (${quote("_status")})`,
      );
      await exec(
        db,
        dialect,
        `CREATE INDEX ${quote(`${table}_publish_at_idx`)} ON ${quote(table)} (${quote("_publish_at")})`,
      );
      await exec(
        db,
        dialect,
        `CREATE INDEX ${quote(`${table}_unpublish_at_idx`)} ON ${quote(table)} (${quote("_unpublish_at")})`,
      );
    }
    if (softDelete) {
      await exec(
        db,
        dialect,
        `CREATE INDEX ${quote(`${table}_deleted_idx`)} ON ${quote(table)} (${quote("deleted_at")})`,
      );
    }
    await ensureFieldIndexes(db, dialect, table, def.fields);
    await ensurePaginationIndex(db, dialect, table, { tenantScoped, hasCreatedAt });
    if (def.fts) await ensureFtsObjects(db, dialect, table, def.fields);
    return;
  }

  const existing = await introspectColumns(db, dialect, table);
  // Backfill: existing collections get tenant_id when promoted to tenant-scoped.
  if (tenantScoped && !existing.has("tenant_id")) {
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("tenant_id")} ${sqlTypeFor("text", dialect)}`,
    );
    await exec(
      db,
      dialect,
      `CREATE INDEX ${quote(`${table}_tenant_idx`)} ON ${quote(table)} (${quote("tenant_id")})`,
    );
  }
  // Promote an existing collection to soft-delete by adding the column.
  if (softDelete && !existing.has("deleted_at")) {
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("deleted_at")} ${sqlTypeFor("timestamp", dialect)}`,
    );
    await exec(
      db,
      dialect,
      `CREATE INDEX ${quote(`${table}_deleted_idx`)} ON ${quote(table)} (${quote("deleted_at")})`,
    );
  }
  // Promote an existing collection to versioned + backfill `_publish_at` onto
  // collections that were already versioned before scheduled publishing existed.
  // Same idempotent helper the publish path calls, so both stay in lockstep.
  if (versioned) {
    await ensureVersionedColumns(db, dialect, table);
  }
  for (const f of def.fields) {
    if (existing.has(f.name)) continue;
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${columnDefSql(f, dialect)}`,
    );
  }
  // Run after column adds so a freshly-added indexed field gets its index, and
  // so a field that gained `indexed` on a later update is picked up too.
  await ensureFieldIndexes(db, dialect, table, def.fields);
  // Backfills the keyset/default-sort composite onto collections created
  // before it existed (IF NOT EXISTS makes the create-branch call a no-op here).
  await ensurePaginationIndex(db, dialect, table, { tenantScoped, hasCreatedAt });
  // FTS objects are additive too — a collection that gains `fts` (or its first
  // `searchable` field) on a later PATCH picks them up here.
  if (def.fts) await ensureFtsObjects(db, dialect, table, def.fields);
};

export const dropField = async (
  db: AnyDb,
  dialect: Dialect,
  table: string,
  fieldName: string,
): Promise<void> => {
  await exec(
    db,
    dialect,
    `ALTER TABLE ${quote(table)} DROP COLUMN ${quote(fieldName)}`,
  );
};

export const dropCollection = async (
  db: AnyDb,
  dialect: Dialect,
  table: string,
  options: { adopted?: boolean } = {},
): Promise<void> => {
  // Refuse to drop an adopted (user-owned) table. The adopt flow's
  // headline guarantee is that we never touch the underlying table; the
  // `collections` metadata + permissions + revisions are cleared by the
  // caller, the physical table stays put. (a known upstream issue — closed
  // "not planned" — is exactly the footgun we won't reproduce.)
  if (options.adopted) return;
  await exec(db, dialect, `DROP TABLE IF EXISTS ${quote(table)}`);
  // SQLite keeps full-text content in a separate FTS5 shadow table — drop it
  // alongside (no-op when the collection never had FTS). Postgres holds the
  // index inline as a `_fts` column, so it goes with the table above.
  if (dialect === "sqlite") {
    await exec(db, dialect, `DROP TABLE IF EXISTS ${quote(ftsTableName(table))}`);
  }
};
