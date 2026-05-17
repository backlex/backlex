/**
 * Collection adoption — pure service layer.
 *
 * "Adopting" a table = registering a workeros `collections` row that points
 * at a physical table the user already owns, **without** any DDL on that
 * table. The schema-applier's `adopted` branch is a no-op (see
 * `packages/db/src/schema-applier.ts`); `routes/items.ts` reads
 * `pkColumn` / `hasCreatedAt` / `hasUpdatedAt` to drive its conditional
 * column handling, and ownership for `ownerScoped` adopted collections
 * lives in the side table `item_ownership` rather than an injected column.
 *
 * This module is split out of the route so the listing/inspection helpers
 * stay DB-dialect-aware in one place and the route stays a thin shell.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import type { FieldType } from "@workeros/db";

type Dialect = "pg" | "sqlite";
type AnyDb = PgDb | SqliteDb;

interface DbCtx {
  db: AnyDb;
  dialect: Dialect;
}

/**
 * System tables that must never appear in the adopt picker. We include
 * every workeros-managed table (auth, multi-tenant control plane, items
 * subsystem, etc.) plus the various per-runtime bookkeeping tables that
 * each database engine creates on its own (`__drizzle_migrations`,
 * `_cf_KV`, `d1_migrations`).
 *
 * Managed dynamic collections live in `c_<tenantPrefix>_<slug>` tables,
 * filtered separately by the `c_` prefix check — we don't list them here
 * since the prefix catches every workspace, but `c_*` matching stays
 * authoritative.
 */
export const SYSTEM_TABLES: ReadonlySet<string> = new Set([
  "collections",
  "permissions",
  "roles",
  "user_roles",
  "users",
  "sessions",
  "accounts",
  "verifications",
  "tenants",
  "tenant_members",
  "passkey",
  "api_keys",
  "email_config",
  "email_templates",
  "auth_config",
  "saml_providers",
  "ldap_configs",
  "app_users",
  "app_sessions",
  "app_verifications",
  "external_identities",
  "revisions",
  "comments",
  "activity_log",
  "webhooks",
  "flows",
  "folders",
  "files",
  "scheduled_tasks",
  "embeddings",
  "workspace_config",
  "item_ownership",
  "activity",
  "app_accounts",
  "app_settings",
  "app_user_roles",
  "backups",
  "functions",
  "i18n_strings",
  "notifications",
  "saved_panels",
  "webhook_deliveries",
  "__drizzle_migrations",
  "_cf_KV",
  "d1_migrations",
]);

/** Reserved names on the workeros side — adopting a table whose column
 *  collides with one of these will be flagged in the inspect response so
 *  the admin sees the issue before applying. The column can still be
 *  adopted, but the API maps it through with the same name; downstream
 *  callers may need to alias. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "owner_id",
  "_status",
  "_published_at",
]);

const runQuery = async <T>(ctx: DbCtx, query: ReturnType<typeof sql.raw>): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = (await (ctx.db as PgDb).execute(query)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) {
      return (r as { rows: T[] }).rows;
    }
    return r as T[];
  }
  return (await (ctx.db as { all: (q: typeof query) => Promise<T[]> }).all(query)) as T[];
};

export interface AdoptableTable {
  name: string;
  columns: number;
  rowCount: number;
  /** Non-null = the table is shown but cannot be adopted (with reason). */
  disabled: string | null;
}

/**
 * List every physical table in the active database, minus:
 *   - managed `c_*` collection tables
 *   - workeros system tables (see `SYSTEM_TABLES`)
 *   - tables already adopted (caller passes `excludeTables`)
 *
 * Each row carries a best-effort `rowCount` and a `disabled` reason
 * when the table can be listed but not adopted (composite PK / view /
 * unsupported shape).
 */
export const listAdoptableTables = async (
  ctx: DbCtx,
  excludeTables: ReadonlySet<string>,
): Promise<AdoptableTable[]> => {
  if (ctx.dialect === "pg") {
    return listAdoptablePg(ctx, excludeTables);
  }
  return listAdoptableSqlite(ctx, excludeTables);
};

const listAdoptablePg = async (
  ctx: DbCtx,
  excludeTables: ReadonlySet<string>,
): Promise<AdoptableTable[]> => {
  // information_schema lets us pull table_name + table_type in one shot;
  // we surface views with `disabled = "View — adoption requires a real table"`
  // so the admin sees them rather than wondering why they're missing.
  type Row = { table_name: string; table_type: string };
  const rows = await runQuery<Row>(
    ctx,
    sql.raw(
      `SELECT table_name, table_type
         FROM information_schema.tables
        WHERE table_schema = current_schema()
        ORDER BY table_name`,
    ),
  );
  // Pull composite-PK candidates in one query. Tables with > 1 PK column
  // are unsupported (we'd need a compound `item_id` shape we don't have).
  const compositePkRows = await runQuery<{ table_name: string; pk_count: number | string }>(
    ctx,
    sql.raw(
      `SELECT c.relname AS table_name, COUNT(a.attnum) AS pk_count
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE i.indisprimary
          AND n.nspname = current_schema()
        GROUP BY c.relname
        HAVING COUNT(a.attnum) > 1`,
    ),
  );
  const compositePk = new Set(compositePkRows.map((r) => r.table_name));

  // pg_class.reltuples is a planner estimate — accurate enough for a
  // picker and orders of magnitude cheaper than COUNT(*) on large tables.
  const counts = await runQuery<{ relname: string; reltuples: number | string }>(
    ctx,
    sql.raw(
      `SELECT c.relname, c.reltuples
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname = current_schema()`,
    ),
  );
  const countByName = new Map<string, number>();
  for (const r of counts) {
    countByName.set(r.relname, Math.max(0, Math.round(Number(r.reltuples) || 0)));
  }
  // Column count per table.
  const colCounts = await runQuery<{ table_name: string; n: number | string }>(
    ctx,
    sql.raw(
      `SELECT table_name, COUNT(*) AS n
         FROM information_schema.columns
        WHERE table_schema = current_schema()
        GROUP BY table_name`,
    ),
  );
  const colsByName = new Map<string, number>();
  for (const r of colCounts) colsByName.set(r.table_name, Number(r.n) || 0);

  const out: AdoptableTable[] = [];
  for (const r of rows) {
    const name = r.table_name;
    if (!name) continue;
    if (name.startsWith("c_")) continue;
    // Cloudflare D1 reserves the `_cf_*` namespace for internal bookkeeping
    // (`_cf_KV`, `_cf_METADATA`). Probing those triggers a SQLITE_AUTH error,
    // and they're never anything a user wants to adopt — skip the whole
    // prefix rather than enumerating each one as it appears.
    if (name.startsWith("_cf_")) continue;
    if (SYSTEM_TABLES.has(name)) continue;
    if (excludeTables.has(name)) continue;
    let disabled: string | null = null;
    if (r.table_type === "VIEW") {
      disabled = "View — adoption requires a real table";
    } else if (compositePk.has(name)) {
      disabled = "Composite primary key";
    }
    out.push({
      name,
      columns: colsByName.get(name) ?? 0,
      rowCount: countByName.get(name) ?? 0,
      disabled,
    });
  }
  return out;
};

const listAdoptableSqlite = async (
  ctx: DbCtx,
  excludeTables: ReadonlySet<string>,
): Promise<AdoptableTable[]> => {
  type Row = { name: string; type: string };
  const rows = await runQuery<Row>(
    ctx,
    sql.raw(
      `SELECT name, type FROM sqlite_master
        WHERE type IN ('table','view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    ),
  );
  const out: AdoptableTable[] = [];
  for (const r of rows) {
    const name = r.name;
    if (!name) continue;
    if (name.startsWith("c_")) continue;
    // Cloudflare D1 reserves the `_cf_*` namespace for internal bookkeeping
    // (`_cf_KV`, `_cf_METADATA`). Probing those triggers a SQLITE_AUTH error,
    // and they're never anything a user wants to adopt — skip the whole
    // prefix rather than enumerating each one as it appears.
    if (name.startsWith("_cf_")) continue;
    if (SYSTEM_TABLES.has(name)) continue;
    if (excludeTables.has(name)) continue;
    let disabled: string | null = null;
    if (r.type === "view") {
      disabled = "View — adoption requires a real table";
    } else {
      // PRAGMA table_info — pk column counts rows where pk > 0.
      const pragma = await runQuery<{ name: string; type: string; pk: number | string }>(
        ctx,
        sql.raw(`PRAGMA table_info("${name.replace(/"/g, '""')}")`),
      );
      const pkCount = pragma.filter((c) => Number(c.pk) > 0).length;
      if (pkCount > 1) disabled = "Composite primary key";
    }
    let columns = 0;
    let rowCount = 0;
    try {
      const pragma = await runQuery<{ name: string }>(
        ctx,
        sql.raw(`PRAGMA table_info("${name.replace(/"/g, '""')}")`),
      );
      columns = pragma.length;
    } catch {
      // ignore
    }
    try {
      const c = await runQuery<{ n: number | string }>(
        ctx,
        sql.raw(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`),
      );
      rowCount = Number(c[0]?.n ?? 0);
    } catch {
      // ignore — table may have been dropped or be otherwise unreadable
    }
    out.push({ name, columns, rowCount, disabled });
  }
  return out;
};

export interface InspectedColumn {
  name: string;
  dbType: string;
  nullable: boolean;
  isPk: boolean;
  suggested: FieldType | null;
  /** Set when the column name collides with a reserved/system name. */
  reserved?: string;
}

export interface InspectedTable {
  table: string;
  pk: { column: string; dbType: string; supported: boolean } | null;
  columns: InspectedColumn[];
  systemColumnsPresent: {
    createdAt: boolean;
    updatedAt: boolean;
    ownerId: boolean;
  };
  /** Heuristic suggestions for aliasing a non-conventional column to one
   *  of our system fields. Populated when the source table doesn't have
   *  the conventional name but does have something that looks like it
   *  (`inserted_at` for created_at, `user_id` for owner_id, etc.). The
   *  wizard's "system columns" panel surfaces these as preselects. */
  aliasSuggestions: {
    createdAt: string | null;
    updatedAt: string | null;
    ownerId: string | null;
  };
  /** Foreign keys declared on the source table. Composite FKs are
   *  reported with `composite: true` (workeros doesn't model multi-column
   *  references; UI surfaces them as informational, not adoptable).
   *  `targetCollection` is filled in by the route layer after the service
   *  returns — it requires the request's tenant to scope the lookup. */
  foreignKeys: ForeignKey[];
  warnings: string[];
}

export interface ForeignKey {
  /** Source column on the table being inspected. */
  column: string;
  /** Parent table referenced by this FK. */
  referencesTable: string;
  /** Parent column. May be empty string if the source schema omitted the
   *  column list (`REFERENCES parent` without parentheses) and we could
   *  not resolve the parent's PK — flag it but don't fail introspection. */
  referencesColumn: string;
  /** True when this FK spans multiple columns. workeros' relation field
   *  is single-column, so composite FKs are shown but cannot be adopted
   *  as `relation`/`relation_many`. */
  composite: boolean;
  /** Set by the route layer when the parent table matches an existing
   *  collection in the current workspace (lookup by `physical_table`).
   *  Null = no managed/adopted collection in this workspace targets the
   *  same physical table; user must adopt the parent first. */
  targetCollection: { slug: string; id: string } | null;
}

/** Patterns we recognize for each system field, in priority order. The
 *  first one that's present *and* has a compatible type (timestamp-ish
 *  for created/updated, text/uuid for owner) wins. */
const ALIAS_PATTERNS = {
  createdAt: ["created_at", "createdAt", "inserted_at", "insertedAt", "date_created", "dateCreated", "created", "insert_time"],
  updatedAt: ["updated_at", "updatedAt", "modified_at", "modifiedAt", "last_modified", "lastModified", "updated", "modify_time"],
  ownerId: ["owner_id", "ownerId", "user_id", "userId", "created_by", "createdBy", "author_id", "authorId", "owner", "owned_by", "ownedBy"],
} as const;

const isTimestampLike = (col: InspectedColumn): boolean =>
  col.suggested === "timestamp" || col.suggested === "integer";

const isIdLike = (col: InspectedColumn): boolean =>
  col.suggested === "text" || col.suggested === "longtext" || col.suggested === "uuid";

const pickAlias = (
  byName: Map<string, InspectedColumn>,
  patterns: readonly string[],
  typeCheck: (c: InspectedColumn) => boolean,
): string | null => {
  for (const name of patterns) {
    const col = byName.get(name);
    if (col && typeCheck(col)) return col.name;
  }
  return null;
};

/**
 * Map a SQL/driver-reported type string to one of our supported FieldType
 * values, or `null` when the type isn't representable in our field model
 * (array / enum / geometry / unknown). The match is loose on purpose —
 * PG advertises types as `character varying`, SQLite as `VARCHAR(200)`,
 * D1 sometimes folds everything to `TEXT`. We strip the size parameter
 * and lower-case before matching.
 */
const suggestFieldType = (dbType: string): FieldType | null => {
  const t = dbType.toLowerCase().replace(/\(.*\)/, "").trim();
  // text-ish — promote to longtext when the column declares a width > 255.
  const sizeMatch = dbType.match(/\((\d+)/);
  const size = sizeMatch ? Number(sizeMatch[1]) : null;
  if (
    t === "uuid" ||
    /^uniqueidentifier$/.test(t)
  ) return "uuid";
  if (
    t === "varchar" ||
    t === "character varying" ||
    t === "char" ||
    t === "character" ||
    t === "text" ||
    t === "citext" ||
    t === "nvarchar" ||
    t === "nchar"
  ) {
    if (t === "text" || t === "citext") return "longtext";
    if (size !== null && size > 255) return "longtext";
    return "text";
  }
  if (
    t === "int" ||
    t === "int2" ||
    t === "int4" ||
    t === "int8" ||
    t === "integer" ||
    t === "smallint" ||
    t === "bigint" ||
    t === "tinyint" ||
    t === "mediumint" ||
    t === "serial" ||
    t === "bigserial"
  ) return "integer";
  if (
    t === "numeric" ||
    t === "decimal" ||
    t === "real" ||
    t === "double precision" ||
    t === "double" ||
    t === "float" ||
    t === "float4" ||
    t === "float8"
  ) return "number";
  if (t === "boolean" || t === "bool") return "boolean";
  if (t === "json" || t === "jsonb") return "json";
  if (
    t === "timestamp" ||
    t === "timestamptz" ||
    t === "timestamp with time zone" ||
    t === "timestamp without time zone" ||
    t === "datetime" ||
    t === "date" ||
    t === "time"
  ) return "timestamp";
  return null;
};

/**
 * Introspect a physical table and produce the structure the inspect
 * endpoint returns. Throws on tables that don't exist or have composite
 * primary keys (the route maps these to AppError VALIDATION / NOT_FOUND).
 */
export const inspectTable = async (
  ctx: DbCtx,
  table: string,
): Promise<InspectedTable> => {
  if (ctx.dialect === "pg") {
    return inspectPg(ctx, table);
  }
  return inspectSqlite(ctx, table);
};

const inspectPg = async (ctx: DbCtx, table: string): Promise<InspectedTable> => {
  const safe = table.replace(/'/g, "''");
  type ColRow = {
    column_name: string;
    data_type: string;
    udt_name: string;
    character_maximum_length: number | null;
    is_nullable: string;
  };
  const cols = await runQuery<ColRow>(
    ctx,
    sql.raw(
      `SELECT column_name, data_type, udt_name, character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = '${safe}'
        ORDER BY ordinal_position`,
    ),
  );
  if (cols.length === 0) {
    throw new Error(`Table "${table}" not found`);
  }
  // PK columns.
  const pkRows = await runQuery<{ column_name: string }>(
    ctx,
    sql.raw(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE i.indisprimary
          AND n.nspname = current_schema()
          AND c.relname = '${safe}'`,
    ),
  );
  if (pkRows.length > 1) {
    throw new Error("Composite primary keys are not supported");
  }
  const pkName = pkRows[0]?.column_name ?? null;

  const columnsOut: InspectedColumn[] = cols.map((c) => {
    // Prefer udt_name for typed columns like uuid/jsonb (data_type returns
    // "USER-DEFINED" for uuid). Width-bearing types use data_type +
    // character_maximum_length so suggestFieldType can promote to longtext.
    const dbType =
      c.character_maximum_length !== null
        ? `${c.data_type}(${c.character_maximum_length})`
        : c.udt_name && c.data_type === "USER-DEFINED"
          ? c.udt_name
          : c.data_type;
    return {
      name: c.column_name,
      dbType,
      nullable: c.is_nullable === "YES",
      isPk: c.column_name === pkName,
      suggested: suggestFieldType(dbType),
      ...(RESERVED_NAMES.has(c.column_name) ? { reserved: c.column_name } : {}),
    };
  });
  const fks = await listForeignKeysPg(ctx, table);
  return buildInspectResult(table, columnsOut, pkName, fks);
};

const inspectSqlite = async (ctx: DbCtx, table: string): Promise<InspectedTable> => {
  const safe = table.replace(/"/g, '""');
  type ColRow = {
    name: string;
    type: string;
    notnull: number | string;
    pk: number | string;
  };
  const cols = await runQuery<ColRow>(
    ctx,
    sql.raw(`PRAGMA table_info("${safe}")`),
  );
  if (cols.length === 0) {
    throw new Error(`Table "${table}" not found`);
  }
  const pkCols = cols.filter((c) => Number(c.pk) > 0);
  if (pkCols.length > 1) {
    throw new Error("Composite primary keys are not supported");
  }
  const pkName = pkCols[0]?.name ?? null;
  const columnsOut: InspectedColumn[] = cols.map((c) => ({
    name: c.name,
    dbType: c.type || "TEXT",
    nullable: Number(c.notnull) === 0,
    isPk: Number(c.pk) > 0,
    suggested: suggestFieldType(c.type || "TEXT"),
    ...(RESERVED_NAMES.has(c.name) ? { reserved: c.name } : {}),
  }));
  const fks = await listForeignKeysSqlite(ctx, table);
  return buildInspectResult(table, columnsOut, pkName, fks);
};

/**
 * List FKs on a Postgres table. We pull from `pg_constraint` and join
 * `pg_attribute` twice — once for child columns, once for parent — using
 * `unnest WITH ORDINALITY` so composite FK column pairs preserve their
 * declaration order. The plain `= ANY()` form silently rearranges array
 * elements and would corrupt composite tuples.
 */
const listForeignKeysPg = async (
  ctx: DbCtx,
  table: string,
): Promise<ForeignKey[]> => {
  const safe = table.replace(/'/g, "''");
  type Row = {
    conname: string;
    child_col: string;
    parent_table: string;
    parent_col: string;
    ord: number;
  };
  const rows = await runQuery<Row>(
    ctx,
    sql.raw(
      `SELECT c.conname,
              a_child.attname  AS child_col,
              p.relname        AS parent_table,
              a_parent.attname AS parent_col,
              k.ord
         FROM pg_constraint c
         JOIN pg_class      cl ON cl.oid = c.conrelid
         JOIN pg_namespace  n  ON n.oid  = cl.relnamespace
         JOIN pg_class      p  ON p.oid  = c.confrelid
         JOIN unnest(c.conkey)  WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN unnest(c.confkey) WITH ORDINALITY AS f(attnum, ord) ON f.ord = k.ord
         JOIN pg_attribute  a_child  ON a_child.attrelid  = c.conrelid AND a_child.attnum  = k.attnum
         JOIN pg_attribute  a_parent ON a_parent.attrelid = c.confrelid AND a_parent.attnum = f.attnum
        WHERE c.contype = 'f'
          AND n.nspname = current_schema()
          AND cl.relname = '${safe}'
        ORDER BY c.conname, k.ord`,
    ),
  );
  return groupAndShapeFks(
    rows.map((r) => ({
      id: r.conname,
      seq: Number(r.ord),
      child: r.child_col,
      parentTable: r.parent_table,
      parentCol: r.parent_col,
    })),
  );
};

/**
 * SQLite/D1 path. `PRAGMA foreign_key_list(table)` returns one row per
 * column pair; same `id` = same constraint. `to` is NULL when the source
 * schema wrote `REFERENCES parent` without a column list — we resolve
 * that by reading the parent's PK columns and aligning by `seq`.
 */
const listForeignKeysSqlite = async (
  ctx: DbCtx,
  table: string,
): Promise<ForeignKey[]> => {
  const safe = table.replace(/"/g, '""');
  type Row = {
    id: number | string;
    seq: number | string;
    table: string;
    from: string;
    to: string | null;
  };
  const rows = await runQuery<Row>(
    ctx,
    sql.raw(`PRAGMA foreign_key_list("${safe}")`),
  );
  // Resolve NULL `to` against parent PK columns. Group missing-to FKs by
  // parent table to limit the table_info lookups to one per parent.
  const parents = new Set<string>();
  for (const r of rows) {
    if (r.to === null || r.to === "") parents.add(r.table);
  }
  const pkByTable = new Map<string, string[]>();
  for (const parent of parents) {
    const safeParent = parent.replace(/"/g, '""');
    const pkRows = await runQuery<{ name: string; pk: number | string }>(
      ctx,
      sql.raw(`PRAGMA table_info("${safeParent}")`),
    );
    const pks = pkRows
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => c.name);
    pkByTable.set(parent, pks);
  }
  return groupAndShapeFks(
    rows.map((r) => {
      const seq = Number(r.seq);
      const parentCol = r.to ?? pkByTable.get(r.table)?.[seq] ?? "";
      return {
        id: String(r.id),
        seq,
        child: r.from,
        parentTable: r.table,
        parentCol,
      };
    }),
  );
};

const groupAndShapeFks = (
  rows: { id: string | number; seq: number; child: string; parentTable: string; parentCol: string }[],
): ForeignKey[] => {
  // Group by constraint id, sort columns by seq. For single-column FKs
  // (the common case) we still emit one ForeignKey row; composite FKs
  // emit one row per column pair flagged `composite: true` so the UI can
  // disable each of them with a clear reason.
  const groups = new Map<string | number, typeof rows>();
  for (const r of rows) {
    if (!groups.has(r.id)) groups.set(r.id, []);
    groups.get(r.id)!.push(r);
  }
  const out: ForeignKey[] = [];
  for (const cols of groups.values()) {
    cols.sort((a, b) => a.seq - b.seq);
    const isComposite = cols.length > 1;
    for (const c of cols) {
      out.push({
        column: c.child,
        referencesTable: c.parentTable,
        referencesColumn: c.parentCol,
        composite: isComposite,
        targetCollection: null,
      });
    }
  }
  return out;
};

const buildInspectResult = (
  table: string,
  columns: InspectedColumn[],
  pkName: string | null,
  foreignKeys: ForeignKey[] = [],
): InspectedTable => {
  const byName = new Map(columns.map((c) => [c.name, c] as const));
  const pkCol = pkName ? byName.get(pkName) ?? null : null;
  const warnings: string[] = [];
  if (!pkCol) {
    warnings.push("Table has no primary key — adoption requires a single-column PK");
  } else if (pkCol.suggested === null) {
    warnings.push(`Primary key column "${pkCol.name}" has unsupported type ${pkCol.dbType}`);
  }
  const unsupportedCount = columns.filter((c) => c.suggested === null).length;
  if (unsupportedCount > 0) {
    warnings.push(
      `${unsupportedCount} column(s) have unsupported types and will be skipped on import`,
    );
  }
  return {
    table,
    pk: pkCol
      ? {
          column: pkCol.name,
          dbType: pkCol.dbType,
          supported: pkCol.suggested !== null,
        }
      : null,
    columns,
    systemColumnsPresent: {
      createdAt: byName.has("created_at"),
      updatedAt: byName.has("updated_at"),
      ownerId: byName.has("owner_id"),
    },
    aliasSuggestions: {
      createdAt: byName.has("created_at")
        ? null
        : pickAlias(byName, ALIAS_PATTERNS.createdAt, isTimestampLike),
      updatedAt: byName.has("updated_at")
        ? null
        : pickAlias(byName, ALIAS_PATTERNS.updatedAt, isTimestampLike),
      ownerId: byName.has("owner_id")
        ? null
        : pickAlias(byName, ALIAS_PATTERNS.ownerId, isIdLike),
    },
    foreignKeys,
    warnings,
  };
};
