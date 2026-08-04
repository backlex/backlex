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
  // Structural rather than `CollectionRow`: the GraphQL layer carries its own
  // narrower row shape, and this reads exactly one field of it. Widening the
  // parameter is what lets both call the same filter instead of hand-writing a
  // second `tenant_id = ?` that can drift from this one.
  collection: { tenantScoped: boolean },
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
  // Structural for the same reason as `tenantFilter` above.
  collection: { softDelete: boolean },
  qualifier?: string,
): SQL | null => {
  if (!collection.softDelete) return null;
  return qualifier
    ? sql`${sql.identifier(qualifier)}.${sql.identifier("deleted_at")} IS NULL`
    : sql`${sql.identifier("deleted_at")} IS NULL`;
};

/**
 * Build the draft-visibility filter for a versioned collection's read path.
 * Mirrors `deletedFilter`'s shape so it composes through `whereOf`.
 *
 * - non-versioned → `null` (no status filter).
 * - caller WITHOUT publish/update (`canSeeDrafts=false`) → published-only;
 *   drafts, archived, and not-yet-due scheduled items are all hidden.
 * - caller WITH publish/update → honors an explicit
 *   `?status=draft|published|archived`, defaulting to `all` (no filter) so
 *   editors see drafts and archived rows too.
 *
 * The optional `qualifier` table name qualifies `_status` for JOINed queries
 * (the list path's `item_ownership` join), same as `deletedFilter`.
 */
export const draftFilter = (
  collection: CollectionRow,
  canSeeDrafts: boolean,
  status?: string,
  qualifier?: string,
): SQL | null => {
  if (!collection.versioned) return null;
  const col = qualifier
    ? sql`${sql.identifier(qualifier)}.${sql.identifier("_status")}`
    : sql`${sql.identifier("_status")}`;
  if (!canSeeDrafts) return sql`${col} = 'published'`;
  if (status === "draft") return sql`${col} = 'draft'`;
  if (status === "published") return sql`${col} = 'published'`;
  if (status === "archived") return sql`${col} = 'archived'`;
  return null; // "all" — privileged default
};

// Postgres-js's prepared-statement binder calls `byteLength` on params
// when it has no per-column type info from the schema (the dynamic
// `c_*` / adopted tables aren't in Drizzle's type map). Date instances
// reach `byteLength` and throw `ERR_INVALID_ARG_TYPE`. ISO strings round-
// trip cleanly to `timestamptz` and avoid the binder ambiguity entirely.
export const nowFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? new Date().toISOString() : Date.now();

/**
 * Every link of an error's `cause` chain, as the (code, message) pair a
 * constraint check needs.
 *
 * **This exists because reading only the top link is a bug that passes every
 * test in this repo and then fails in production.** Drizzle wraps a driver
 * error in one of its own, and the wrapper ALWAYS has a message of its own
 * ("Failed query: insert into …"). So `err.message ?? err.cause?.message` —
 * which is what both detectors here used to do — never reaches the cause at
 * all: the `??` is satisfied by the wrapper. On bun:sqlite the driver's text
 * happens to survive onto the top-level message, so the tests were green; on D1
 * the words live on `cause`, so **every unique violation on a live collection
 * write answered 500 instead of 409**, and every FK violation 500 instead of
 * 422. `booking.ts` learned this the hard way and grew its own chain walk; this
 * is that walk, moved down here so there is one copy and the twin can go.
 *
 * Depth-capped because a cause chain can be cyclic, and stringified per link
 * because some drivers throw a bare string.
 */
function* constraintSignals(err: unknown): Generator<{ code: string; message: string }> {
  for (let e: unknown = err, depth = 0; e != null && depth < 5; depth++) {
    yield {
      code: String((e as { code?: unknown })?.code ?? ""),
      message: String((e as { message?: unknown })?.message ?? e),
    };
    e = (e as { cause?: unknown }).cause;
  }
}

/**
 * Translate DB-level FK violations into a backlex-shaped error. Adopted
 * tables can carry real FK constraints (D1 enforces them unconditionally;
 * Postgres does the same when the constraint exists). Without this map,
 * any caller that writes a value pointing at a row that doesn't exist
 * gets a 500 — instead we surface it as a 422 the API consumer can act on.
 *
 * The signatures we look for:
 *   - Postgres: `code: "23503"`, message includes "foreign key constraint".
 *   - SQLite (D1 + Bun): error code "SQLITE_CONSTRAINT_FOREIGNKEY" or
 *     message "FOREIGN KEY constraint failed" — on ANY link of the chain.
 */
export const isFkViolation = (err: unknown): boolean => {
  for (const { code, message } of constraintSignals(err)) {
    if (code === "23503") return true; // pg foreign_key_violation
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true;
    // The extended-result-code name is checked against the MESSAGE as well as
    // the code: some drivers put it in the text rather than on a `code` field,
    // and it does not contain the words "foreign key" for the regex to find.
    if (message.includes("SQLITE_CONSTRAINT_FOREIGNKEY")) return true;
    if (/foreign key/i.test(message) && /constraint/i.test(message)) return true;
  }
  return false;
};

export const isUniqueViolation = (err: unknown): boolean => {
  for (const { code, message } of constraintSignals(err)) {
    if (code === "23505") return true; // pg unique_violation
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
    // Same reason as above — and note `/unique constraint/i` does NOT match
    // "SQLITE_CONSTRAINT_UNIQUE" (wrong word order), so dropping these two
    // lines silently narrows the guard. The booking twin checked the message
    // for exactly this and would have lost it in the merge.
    if (message.includes("SQLITE_CONSTRAINT_UNIQUE")) return true;
    if (message.includes("SQLITE_CONSTRAINT_PRIMARYKEY")) return true;
    if (/unique constraint/i.test(message) || /duplicate key value/i.test(message)) return true;
    // The SQLite wording, which `/unique constraint/i` already covers — kept
    // explicit because it is the string the D1 cause actually carries and the
    // one a future edit to that regex must not drop.
    if (message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
};

export const execute = async (ctx: Ctx, query: unknown, db?: unknown): Promise<unknown> => {
  const target = (db ?? ctx.db) as any;
  try {
    if (ctx.dialect === "pg") return await target.execute(query);
    return await target.run(query);
  } catch (e) {
    if (isFkViolation(e)) {
      throw new AppError(
        "VALIDATION",
        "Foreign key violation — one of the relation values points at a row that doesn't exist or was deleted",
      );
    }
    if (isUniqueViolation(e)) {
      throw new AppError(
        "CONFLICT",
        "A row with these values already exists (unique constraint).",
      );
    }
    throw e;
  }
};

export const queryAll = async <T>(ctx: Ctx, query: unknown, db?: unknown): Promise<T[]> => {
  const target = (db ?? ctx.db) as any;
  if (ctx.dialect === "pg") {
    const r = await target.execute(query);
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return r.rows as T[];
    return r as T[];
  }
  return (await target.all(query)) as T[];
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
