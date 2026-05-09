import { sql } from "drizzle-orm";
import type { PgDb } from "./pg";
import type { SqliteDb } from "./sqlite";
import {
  type FieldDef,
  columnDefSql,
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

interface CollectionShape {
  /** Physical table name (e.g. `c_<tenantPrefix>_<slug>`). Caller is
   *  responsible for deriving and passing it; the applier never recomputes. */
  table: string;
  fields: FieldDef[];
  ownerScoped?: boolean;
  /** When true (default), the physical table gets a `tenant_id` column and
   *  reads/writes are scoped to the active tenant via the items router. */
  tenantScoped?: boolean;
  /** When true, the physical table gets `_status` + `_published_at` columns. */
  versioned?: boolean;
}

const systemColumns = (
  dialect: Dialect,
  ownerScoped: boolean,
  versioned: boolean = false,
  tenantScoped: boolean = true,
): string[] => {
  const ts = sqlTypeFor("timestamp", dialect);
  const cols = [
    `${quote("id")} ${sqlTypeFor("uuid", dialect)} PRIMARY KEY`,
    ...(tenantScoped ? [`${quote("tenant_id")} ${sqlTypeFor("text", dialect)}`] : []),
    ...(ownerScoped ? [`${quote("owner_id")} ${sqlTypeFor("text", dialect)}`] : []),
    `${quote("created_at")} ${ts} NOT NULL`,
    `${quote("updated_at")} ${ts} NOT NULL`,
    ...(versioned
      ? [
          `${quote("_status")} ${sqlTypeFor("text", dialect)} NOT NULL DEFAULT 'draft'`,
          `${quote("_published_at")} ${ts}`,
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
 * Idempotent: creates the physical table for a collection, or adds any
 * columns that aren't already present. Never drops columns; for that, use
 * `dropField` explicitly.
 */
export const applyCollection = async (
  db: AnyDb,
  dialect: Dialect,
  def: CollectionShape,
): Promise<void> => {
  validateFields(def.fields);
  const table = def.table;
  const ownerScoped = Boolean(def.ownerScoped);
  // Default to tenant-scoped: workspaces are the recommended posture and
  // collections that opt out must do so explicitly.
  const tenantScoped = def.tenantScoped !== false;
  const versioned = Boolean(def.versioned);

  if (!(await tableExists(db, dialect, table))) {
    const cols = [
      ...systemColumns(dialect, ownerScoped, versioned, tenantScoped),
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
    }
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
  // Promote an existing collection to versioned by adding the system cols.
  if (versioned && !existing.has("_status")) {
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("_status")} ${sqlTypeFor("text", dialect)} NOT NULL DEFAULT 'draft'`,
    );
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("_published_at")} ${sqlTypeFor("timestamp", dialect)}`,
    );
    await exec(
      db,
      dialect,
      `CREATE INDEX ${quote(`${table}_status_idx`)} ON ${quote(table)} (${quote("_status")})`,
    );
  }
  for (const f of def.fields) {
    if (existing.has(f.name)) continue;
    await exec(
      db,
      dialect,
      `ALTER TABLE ${quote(table)} ADD COLUMN ${columnDefSql(f, dialect)}`,
    );
  }
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
): Promise<void> => {
  await exec(db, dialect, `DROP TABLE IF EXISTS ${quote(table)}`);
};
