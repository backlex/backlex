import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { Ctx } from "../../context";
import type { CollectionRow } from "./collection-loader";

/**
 * Build a `tenant_id = ?` filter when the collection is tenant-scoped.
 * When the collection isn't tenant-scoped (legacy/system data), returns null
 * so callers can compose with `whereOf` cleanly.
 */
export const tenantFilter = (
  collection: CollectionRow,
  auth: { tenantId?: string | null; roles: string[] },
): SQL | null => {
  if (!collection.tenantScoped) return null;
  if (!auth.tenantId) return sql`(1=0)`;
  return sql`${sql.identifier("tenant_id")} = ${auth.tenantId}`;
};

/**
 * Build a `deleted_at IS NULL` filter when the collection uses soft-delete,
 * so every read path hides rows that were soft-deleted. Returns null
 * otherwise so callers can compose with `whereOf` cleanly. Soft-delete is
 * managed-only (adopted collections force it off), so the column is always
 * the conventional `deleted_at` — no aliasing to resolve. The optional
 * `qualifier` table name qualifies the column for queries that JOIN (e.g.
 * the list path's `item_ownership` join), mirroring how the tenant filter is
 * re-qualified there.
 */
export const deletedFilter = (
  collection: CollectionRow,
  qualifier?: string,
): SQL | null => {
  if (!collection.softDelete) return null;
  return qualifier
    ? sql`${sql.identifier(qualifier)}.${sql.identifier("deleted_at")} IS NULL`
    : sql`${sql.identifier("deleted_at")} IS NULL`;
};

// Postgres-js's prepared-statement binder calls `byteLength` on params
// when it has no per-column type info from the schema (the dynamic
// `c_*` / adopted tables aren't in Drizzle's type map). Date instances
// reach `byteLength` and throw `ERR_INVALID_ARG_TYPE`. ISO strings round-
// trip cleanly to `timestamptz` and avoid the binder ambiguity entirely.
export const nowFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? new Date().toISOString() : Date.now();

/**
 * Translate DB-level FK violations into a backlex-shaped error. Adopted
 * tables can carry real FK constraints (D1 enforces them unconditionally;
 * Postgres does the same when the constraint exists). Without this map,
 * any caller that writes a value pointing at a row that doesn't exist
 * gets a 500 — instead we surface it as a 422 the API consumer can act on.
 *
 * The signatures we look for:
 *   - Postgres: `code: "23503"` on the wrapped error, message includes
 *     "foreign key constraint".
 *   - SQLite (D1 + Bun): error code "SQLITE_CONSTRAINT_FOREIGNKEY" or
 *     message starting with "FOREIGN KEY constraint failed".
 */
export const isFkViolation = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  if (!e) return false;
  const code = e.code ?? e.cause?.code ?? "";
  const msg = (e.message ?? e.cause?.message ?? "").toString();
  if (code === "23503") return true;
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true;
  if (/foreign key/i.test(msg) && /constraint/i.test(msg)) return true;
  return false;
};

export const execute = async (ctx: Ctx, query: unknown): Promise<unknown> => {
  try {
    if (ctx.dialect === "pg") return await (ctx.db as any).execute(query);
    return await (ctx.db as any).run(query);
  } catch (e) {
    if (isFkViolation(e)) {
      throw new AppError(
        "VALIDATION",
        "Foreign key violation — one of the relation values points at a row that doesn't exist or was deleted",
      );
    }
    throw e;
  }
};

export const queryAll = async <T>(ctx: Ctx, query: unknown): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as any).execute(query);
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return r.rows as T[];
    return r as T[];
  }
  return (await (ctx.db as any).all(query)) as T[];
};

export const whereOf = (...frags: (SQL | null | undefined)[]): SQL => {
  const valid = frags.filter((f): f is SQL => f != null);
  if (valid.length === 0) return sql``;
  return sql`WHERE ${sql.join(valid, sql` AND `)}`;
};

export const pkEq = (pkColumn: string, id: string): SQL =>
  sql`${sql.identifier(pkColumn)} = ${id}`;

/**
 * Resolve the *physical* column name for a logical system field. Returns
 * null when the field doesn't exist on this collection (e.g. has_created_at
 * is false). Adopted collections can alias `created_at` → `inserted_at` and
 * friends; managed collections always pass through the conventional name.
 *
 * For `owner_id` there's a third possibility: the column may live on the
 * side-table `item_ownership` (adopted + ownerScoped + no alias). Callers
 * that care about the side-table case should also check
 * `usesOwnershipSideTable`.
 */
export const physicalSystemCol = (
  collection: CollectionRow,
  logical: "created_at" | "updated_at" | "owner_id",
): string | null => {
  if (logical === "created_at") {
    return collection.hasCreatedAt
      ? (collection.createdAtColumn ?? "created_at")
      : null;
  }
  if (logical === "updated_at") {
    return collection.hasUpdatedAt
      ? (collection.updatedAtColumn ?? "updated_at")
      : null;
  }
  // owner_id
  if (!collection.ownerScoped) return null;
  if (collection.adopted) {
    return collection.ownerIdColumn ?? null;
    // null here means the join path is active; caller must consult
    // `usesOwnershipSideTable` to know whether to read from `item_ownership`.
  }
  return "owner_id"; // managed default
};

/**
 * Whether this collection's `owner_id` lives in the side table rather than
 * on the physical row. The two-pronged check is essentially the contract:
 * adopted collections never had an `owner_id` column injected (the
 * schema-applier is a no-op for them), so when they're also owner-scoped
 * *and* haven't aliased an existing column, ownership must come from
 * `item_ownership` via a join.
 */
export const usesOwnershipSideTable = (collection: CollectionRow): boolean =>
  collection.adopted && collection.ownerScoped && !collection.ownerIdColumn;

/**
 * FROM clause for a collection's physical table, plus a LEFT JOIN to
 * `item_ownership` when ownership lives there. The join surfaces
 * `owner_id` on every row so projection/filter/sort can keep referring to
 * it as a regular column — `compileCondition` doesn't need to know
 * anything about ownership tables. Unqualified `owner_id` references
 * disambiguate cleanly because adopted tables never had the column.
 */
export const fromOf = (collection: CollectionRow): SQL => {
  const tbl = sql.identifier(collection.physicalTable);
  if (usesOwnershipSideTable(collection)) {
    return sql`${tbl} LEFT JOIN ${sql.identifier("item_ownership")}
      ON ${sql.identifier("item_ownership")}.${sql.identifier("collection_id")} = ${collection.id}
      AND ${sql.identifier("item_ownership")}.${sql.identifier("item_id")} = ${tbl}.${sql.identifier(collection.pkColumn)}`;
  }
  return sql`${tbl}`;
};

/**
 * `SELECT *` replacement that surfaces aliased system columns (when an
 * adopted table uses non-conventional names like `inserted_at`) and joins
 * in `item_ownership.owner_id` (when ownership lives in the side-table).
 * For managed collections this is just `*`.
 *
 * Aliased columns appear *twice* in the response — once under their real
 * name (via `*`) and once under the logical name (via the `AS` clause).
 * That's a feature, not a bug: it keeps deserializeRow + downstream API
 * consumers reading `created_at` consistently while letting power users
 * inspect the source column too.
 */
export const selectStar = (collection: CollectionRow): SQL => {
  const tbl = sql.identifier(collection.physicalTable);
  const extras: SQL[] = [];
  const createdAlias = collection.hasCreatedAt && collection.createdAtColumn && collection.createdAtColumn !== "created_at";
  const updatedAlias = collection.hasUpdatedAt && collection.updatedAtColumn && collection.updatedAtColumn !== "updated_at";
  if (createdAlias) {
    extras.push(sql`${tbl}.${sql.identifier(collection.createdAtColumn!)} AS ${sql.identifier("created_at")}`);
  }
  if (updatedAlias) {
    extras.push(sql`${tbl}.${sql.identifier(collection.updatedAtColumn!)} AS ${sql.identifier("updated_at")}`);
  }
  if (collection.ownerScoped && collection.adopted) {
    if (collection.ownerIdColumn) {
      extras.push(sql`${tbl}.${sql.identifier(collection.ownerIdColumn)} AS ${sql.identifier("owner_id")}`);
    } else {
      // Side-table path — join surfaces the column from `item_ownership`.
      extras.push(sql`${sql.identifier("item_ownership")}.${sql.identifier("owner_id")} AS ${sql.identifier("owner_id")}`);
    }
  }
  if (extras.length === 0) return sql`*`;
  return sql`${tbl}.*, ${sql.join(extras, sql`, `)}`;
};

/** Build a single column reference for the SELECT list. System fields
 *  (`created_at`, `updated_at`, `owner_id`) get aliased to their physical
 *  column when the collection maps them somewhere else. */
export const selectColRef = (collection: CollectionRow, col: string): SQL => {
  const tbl = sql.identifier(collection.physicalTable);
  if (col === "owner_id") {
    if (usesOwnershipSideTable(collection)) {
      return sql`${sql.identifier("item_ownership")}.${sql.identifier("owner_id")} AS ${sql.identifier("owner_id")}`;
    }
    if (collection.ownerIdColumn && collection.ownerIdColumn !== "owner_id") {
      return sql`${tbl}.${sql.identifier(collection.ownerIdColumn)} AS ${sql.identifier("owner_id")}`;
    }
  }
  if (col === "created_at" && collection.createdAtColumn && collection.createdAtColumn !== "created_at") {
    return sql`${tbl}.${sql.identifier(collection.createdAtColumn)} AS ${sql.identifier("created_at")}`;
  }
  if (col === "updated_at" && collection.updatedAtColumn && collection.updatedAtColumn !== "updated_at") {
    return sql`${tbl}.${sql.identifier(collection.updatedAtColumn)} AS ${sql.identifier("updated_at")}`;
  }
  return sql`${sql.identifier(col)}`;
};
