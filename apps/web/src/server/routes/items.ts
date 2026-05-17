import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, and, eq, type SQL } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import {
  compileCondition,
  type FieldDef,
  validateValue,
  type FieldType,
} from "@workeros/db";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import type { Ctx } from "../context";
import { parseQuery, resolveProjection } from "../lib/query";
import { publishEvent } from "../services/events";
import { elapsedMs, keepAlive, recordActivity, requestMeta } from "../services/activity";
import { recordRevision } from "../services/revisions";
import { embedAndUpsert, deleteVector } from "../services/vectorize";
import { loadAppSettings } from "../services/settings";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

interface CollectionRow {
  /** Collections.id — primary key in the metadata table. Needed for the
   *  `item_ownership` semi-join on adopted owner-scoped collections. */
  id: string;
  slug: string;
  /** Physical table backing the dynamic data (e.g. `c_<tenantPrefix>_<slug>`). */
  physicalTable: string;
  fields: FieldDef[];
  ownerScoped: boolean;
  /** Default true. When true, the physical table has a tenant_id column and
   *  reads/writes are scoped to the active tenant. */
  tenantScoped: boolean;
  versioned?: boolean;
  /** Auto-vectorize items on write (POST/PATCH) and clear on delete. The
   *  fields that contribute to the embed text are the ones whose `FieldDef`
   *  has `vectorize: true` (text/longtext only). */
  vectorize: boolean;
  /** Embedding model key (`EMBEDDING_MODELS` keys). Null → env default. */
  vectorizeModel: string | null;
  /** Comma-separated default sort (Directus shape, `-` prefix = DESC). Null
   *  falls back to `-created_at` in `parseQuery`. */
  defaultSort: string | null;
  /** True when this collection was adopted from an existing physical table
   *  (vs. we created it). When true, schema-applier never DDLs the table
   *  and ownership lives in `item_ownership` instead of an injected
   *  `owner_id` column. */
  adopted: boolean;
  /** Primary-key column name on the physical table. Default `id`; adoption
   *  surfaces this for source tables with a different PK name. */
  pkColumn: string;
  /** Whether the physical table has these columns. Always true for managed
   *  collections; flexible for adopted ones. Used by POST/PATCH writes,
   *  projection, and the `parseQuery` default-sort fallback. */
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
  /** Physical column names backing the system fields. Null = use the
   *  conventional name (`created_at`/`updated_at`/`owner_id`). Adopted
   *  collections can map to whatever the source table already calls
   *  these — `inserted_at`, `user_id`, etc. */
  createdAtColumn: string | null;
  updatedAtColumn: string | null;
  /** When set on an adopted owner-scoped collection, ownership reads
   *  from this column on the source table (alias path) instead of the
   *  `item_ownership` side-table (join path). */
  ownerIdColumn: string | null;
}

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

const loadCollection = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  slug: string,
): Promise<CollectionRow> => {
  if (!tenantId) {
    throw new AppError(
      "UNAUTHORIZED",
      "Active tenant required to access collections",
    );
  }
  const t = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", `Collection "${slug}" not found`);
  const r = rows[0] as Record<string, unknown>;
  return {
    id: r.id as string,
    slug: r.slug as string,
    physicalTable: (r.physicalTable ?? r.physical_table) as string,
    fields: r.fields as FieldDef[],
    ownerScoped: Boolean(r.ownerScoped ?? r.owner_scoped),
    tenantScoped: r.tenantScoped ?? r.tenant_scoped ?? true ? true : false,
    versioned: Boolean(r.versioned),
    vectorize: Boolean(r.vectorize),
    vectorizeModel: ((r.vectorizeModel ?? r.vectorize_model) as string | null | undefined) ?? null,
    defaultSort: ((r.defaultSort ?? r.default_sort) as string | null | undefined) ?? null,
    adopted: Boolean(r.adopted),
    pkColumn: ((r.pkColumn ?? r.pk_column) as string | undefined) ?? "id",
    hasCreatedAt: (r.hasCreatedAt ?? r.has_created_at) === false ? false : true,
    hasUpdatedAt: (r.hasUpdatedAt ?? r.has_updated_at) === false ? false : true,
    createdAtColumn: ((r.createdAtColumn ?? r.created_at_column) as string | null | undefined) ?? null,
    updatedAtColumn: ((r.updatedAtColumn ?? r.updated_at_column) as string | null | undefined) ?? null,
    ownerIdColumn: ((r.ownerIdColumn ?? r.owner_id_column) as string | null | undefined) ?? null,
  };
};

/**
 * Build a `tenant_id = ?` filter when the collection is tenant-scoped.
 * When the collection isn't tenant-scoped (legacy/system data), returns null
 * so callers can compose with `whereOf` cleanly.
 */
const tenantFilter = (
  collection: CollectionRow,
  auth: { tenantId?: string | null; roles: string[] },
): SQL | null => {
  if (!collection.tenantScoped) return null;
  if (!auth.tenantId) return sql`(1=0)`;
  return sql`${sql.identifier("tenant_id")} = ${auth.tenantId}`;
};


const serialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value === undefined || value === null) return null;
  if (dialect === "sqlite") {
    if (type === "json" || type === "relation_many" || type === "i18n_text") {
      // relation_many is an array of foreign ids — store as JSON text on
      // SQLite so the same column pattern as `json` works (no native array).
      // i18n_text is a `{locale: value}` map — same story.
      return JSON.stringify(value);
    }
    if (type === "boolean") return value ? 1 : 0;
    if (type === "timestamp") {
      return value instanceof Date ? value.getTime() : Number(value);
    }
  } else {
    if (type === "timestamp" && !(value instanceof Date)) {
      return new Date(value as string | number);
    }
    if (type === "relation_many" && typeof value === "string") {
      // Be forgiving — caller might send already-stringified JSON.
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
  }
  return value;
};

const deserialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value === null || value === undefined) return value;
  if (dialect === "sqlite") {
    if (type === "json" || type === "relation_many" || type === "i18n_text") {
      return typeof value === "string" ? JSON.parse(value) : value;
    }
    if (type === "boolean") return Boolean(value);
    if (type === "timestamp") return new Date(value as number).toISOString();
  }
  return value;
};

const projectFields = (
  out: Record<string, unknown>,
  allowed: Set<string> | null,
): Record<string, unknown> => {
  if (!allowed) return out;
  const sysKeep = new Set(["id", "createdAt", "updatedAt", "ownerId"]);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) {
    if (sysKeep.has(k) || allowed.has(k)) filtered[k] = v;
  }
  return filtered;
};

const deserializeRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  dialect: "pg" | "sqlite",
  ownerScoped: boolean,
  projection: string[] | null = null,
  collection?: { pkColumn: string; hasCreatedAt: boolean; hasUpdatedAt: boolean },
): Record<string, unknown> => {
  const pk = collection?.pkColumn ?? "id";
  const hasCreatedAt = collection?.hasCreatedAt ?? true;
  const hasUpdatedAt = collection?.hasUpdatedAt ?? true;
  const includeAll = !projection;
  const sel = new Set(projection ?? []);
  const out: Record<string, unknown> = {};
  if (includeAll || sel.has("id") || sel.has(pk)) out.id = row[pk] ?? row.id;
  if (hasCreatedAt && (includeAll || sel.has("created_at")))
    out.createdAt = deserialize(row.created_at, "timestamp", dialect);
  if (hasUpdatedAt && (includeAll || sel.has("updated_at")))
    out.updatedAt = deserialize(row.updated_at, "timestamp", dialect);
  if ((includeAll && ownerScoped) || sel.has("owner_id"))
    out.ownerId = row.owner_id ?? null;
  // Versioned-collection system columns — exposed only when present.
  if (row._status !== undefined) {
    out._status = row._status;
    out._publishedAt =
      row._published_at != null
        ? deserialize(row._published_at, "timestamp", dialect)
        : null;
  }
  for (const f of fields) {
    if (includeAll || sel.has(f.name)) {
      out[f.name] = deserialize(row[f.name], f.type, dialect);
    }
  }
  return out;
};

const validateBody = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  partial: boolean,
  fieldAllow: Set<string> | null,
): void => {
  for (const f of fields) {
    if (f.computed) continue; // never required from the caller
    if (f.required && !partial && (data[f.name] === undefined || data[f.name] === null)) {
      throw new AppError("VALIDATION", `Field "${f.name}" is required`);
    }
  }
  for (const k of Object.keys(data)) {
    const def = fields.find((f) => f.name === k);
    if (!def) {
      throw new AppError("VALIDATION", `Unknown field "${k}"`);
    }
    if (def.computed) {
      throw new AppError(
        "VALIDATION",
        `Field "${k}" is computed (read-only) — drop it from your payload`,
      );
    }
    if (fieldAllow && !fieldAllow.has(k)) {
      throw new AppError("FORBIDDEN", `No permission to write field "${k}"`);
    }
    try {
      validateValue(def, data[k]);
    } catch (e) {
      throw new AppError("VALIDATION", (e as Error).message);
    }
  }
};

/**
 * Verify that every `relation` / `relation_many` value in the payload points
 * at a real row in the target collection. Empty string and null are
 * skipped (treated as "no relation"); a missing target id throws 422.
 *
 * Batches by target slug so a payload with N `customer_id` references
 * costs one SELECT per target collection, not one per id.
 *
 * Loading the target collection through `loadCollection` keeps the lookup
 * tenant-scoped — a value pointing at a collection in another workspace
 * fails with the same "not found" wording.
 */
const validateRelations = async (
  data: Record<string, unknown>,
  fields: FieldDef[],
  ctx: Ctx,
  tenantId: string | null | undefined,
): Promise<void> => {
  const checks = new Map<string, Set<string>>();
  for (const f of fields) {
    if (f.type !== "relation" && f.type !== "relation_many") continue;
    if (!f.to) continue;
    const val = data[f.name];
    if (val === undefined || val === null || val === "") continue;
    let ids: string[] = [];
    if (f.type === "relation_many") {
      if (Array.isArray(val)) {
        ids = val
          .map((x) => (typeof x === "string" ? x : String(x ?? "")))
          .filter((x) => x !== "");
      }
    } else if (typeof val === "string") {
      ids = [val];
    }
    if (ids.length === 0) continue;
    const set = checks.get(f.to) ?? new Set<string>();
    for (const id of ids) set.add(id);
    checks.set(f.to, set);
  }
  if (checks.size === 0) return;
  for (const [slug, idSet] of checks) {
    let target: CollectionRow;
    try {
      target = await loadCollection(ctx, tenantId, slug);
    } catch {
      throw new AppError(
        "VALIDATION",
        `Relation target collection "${slug}" not found in this workspace`,
      );
    }
    const ids = [...idSet];
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${sql.identifier(target.pkColumn)} AS ${sql.identifier("__rel_id")}
          FROM ${sql.identifier(target.physicalTable)}
          WHERE ${sql.identifier(target.pkColumn)} IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
    const found = new Set(rows.map((r) => String(r["__rel_id"] ?? "")));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      const sample = missing.slice(0, 3).join(", ");
      const suffix = missing.length > 3 ? ` (…and ${missing.length - 3} more)` : "";
      throw new AppError(
        "VALIDATION",
        `Relation target "${slug}" has no row(s) with id: ${sample}${suffix}`,
      );
    }
  }
};

const hasI18nField = (fields: FieldDef[]): boolean =>
  fields.some((f) => f.type === "i18n_text");

/**
 * Project i18n_text fields down to a single locale's string for response.
 * When `locale === "*"` (or null) the full `{en, tr, …}` map is returned
 * unchanged — useful for admin UIs that want to render every locale.
 *
 * Fallback chain: requested locale → workspace default → first non-empty
 * map entry. The third step is deterministic only because map keys are
 * iterated in insertion order, but it's strictly a last-resort.
 */
const localizeRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  locale: string | null,
  defaultLocale: string | null,
): Record<string, unknown> => {
  if (!locale || locale === "*") return row;
  for (const f of fields) {
    if (f.type !== "i18n_text") continue;
    const v = row[f.name];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const map = v as Record<string, unknown>;
      const picked =
        map[locale] ??
        (defaultLocale ? map[defaultLocale] : undefined) ??
        Object.values(map)[0] ??
        null;
      row[f.name] = picked;
    }
  }
  return row;
};

/**
 * Merge incoming i18n_text patch values into the existing JSON map so a
 * client that writes only one locale doesn't blow away the others.
 *
 * - Patch is a plain object → spread into existing (per-locale upsert).
 * - Patch is a string AND `?locale=xx` query is set → treat as `{xx: value}`
 *   and merge into existing. The handler converts the patch in-place.
 * - Patch is `null` → clears the field entirely (caller's choice).
 * - Anything else throws — strings without a locale param aren't a valid
 *   shape for a JSON column.
 */
const mergeI18nPatch = (
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
  fields: FieldDef[],
  writeLocale: string | null,
): void => {
  for (const f of fields) {
    if (f.type !== "i18n_text") continue;
    if (!(f.name in patch)) continue;
    const incoming = patch[f.name];
    if (incoming === null) continue;

    const current = existing[f.name];
    const base =
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};

    if (typeof incoming === "string") {
      if (!writeLocale || writeLocale === "*") {
        throw new AppError(
          "VALIDATION",
          `Field "${f.name}" is i18n_text — send {locale: value} or use ?locale=xx`,
        );
      }
      base[writeLocale] = incoming;
      patch[f.name] = base;
      continue;
    }

    if (typeof incoming === "object" && !Array.isArray(incoming)) {
      patch[f.name] = { ...base, ...(incoming as Record<string, unknown>) };
      continue;
    }

    throw new AppError(
      "VALIDATION",
      `Field "${f.name}" must be an object or string for i18n_text`,
    );
  }
};

const nowFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? new Date() : Date.now();

/**
 * Translate DB-level FK violations into a workeros-shaped error. Adopted
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
const isFkViolation = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  if (!e) return false;
  const code = e.code ?? e.cause?.code ?? "";
  const msg = (e.message ?? e.cause?.message ?? "").toString();
  if (code === "23503") return true;
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true;
  if (/foreign key/i.test(msg) && /constraint/i.test(msg)) return true;
  return false;
};

const execute = async (ctx: Ctx, query: unknown): Promise<unknown> => {
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

const queryAll = async <T>(ctx: Ctx, query: unknown): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as any).execute(query);
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return r.rows as T[];
    return r as T[];
  }
  return (await (ctx.db as any).all(query)) as T[];
};

const collectionFromParam = (c: Context<AppBindings>) =>
  c.req.param("slug" as never) as string;

const whereOf = (...frags: (SQL | null | undefined)[]): SQL => {
  const valid = frags.filter((f): f is SQL => f != null);
  if (valid.length === 0) return sql``;
  return sql`WHERE ${sql.join(valid, sql` AND `)}`;
};

const pkEq = (pkColumn: string, id: string): SQL =>
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
const physicalSystemCol = (
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
const usesOwnershipSideTable = (collection: CollectionRow): boolean =>
  collection.adopted && collection.ownerScoped && !collection.ownerIdColumn;

/**
 * Rewrite a permission/filter Condition tree so logical system-field keys
 * (`created_at`, `updated_at`, `owner_id`) become the actual physical
 * column names this collection uses. Without this, `compileCondition`
 * would emit `WHERE "created_at" = ?` against a table whose timestamp
 * column is actually called `inserted_at` and the query would fail.
 */
const rewriteSystemFieldsInCondition = (
  cond: any,
  collection: CollectionRow,
): any => {
  if (cond === null || cond === undefined) return cond;
  if (Array.isArray(cond.$and)) {
    return { $and: cond.$and.map((c: any) => rewriteSystemFieldsInCondition(c, collection)) };
  }
  if (Array.isArray(cond.$or)) {
    return { $or: cond.$or.map((c: any) => rewriteSystemFieldsInCondition(c, collection)) };
  }
  if (cond.$not !== undefined) {
    return { $not: rewriteSystemFieldsInCondition(cond.$not, collection) };
  }
  // Leaf — a `{field: comparison}` map. Rewrite system-field keys.
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(cond)) {
    if (key === "created_at" || key === "updated_at" || key === "owner_id") {
      const physical = physicalSystemCol(collection, key);
      if (physical) {
        out[physical] = val;
        continue;
      }
      // For owner_id on the side-table path: keep the logical key so the
      // LEFT JOIN's `owner_id` resolves it (the join surfaces the column
      // unqualified — see fromOf + selectStar).
      out[key] = val;
      continue;
    }
    out[key] = val;
  }
  return out;
};

/** Rewrite a sort field name to its physical column. Returns the input
 *  unchanged when no mapping applies. */
const rewriteSortField = (field: string, collection: CollectionRow): string => {
  if (field === "created_at" || field === "updated_at" || field === "owner_id") {
    const physical = physicalSystemCol(collection, field);
    if (physical) return physical;
  }
  return field;
};

/**
 * FROM clause for a collection's physical table, plus a LEFT JOIN to
 * `item_ownership` when ownership lives there. The join surfaces
 * `owner_id` on every row so projection/filter/sort can keep referring to
 * it as a regular column — `compileCondition` doesn't need to know
 * anything about ownership tables. Unqualified `owner_id` references
 * disambiguate cleanly because adopted tables never had the column.
 */
const fromOf = (collection: CollectionRow): SQL => {
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
const selectStar = (collection: CollectionRow): SQL => {
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
const selectColRef = (collection: CollectionRow, col: string): SQL => {
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

// Per-collection shapes are added at request time by services/openapi-dynamic.
// The generic endpoints below document the shared envelope; the body and
// item shapes are `record(unknown)` because the field set is dynamic.
const ItemBody = z.record(z.string(), z.unknown()).openapi("ItemBody");
const ItemRow = z.record(z.string(), z.unknown()).openapi("ItemRow");

const ListMeta = z
  .object({
    filter_count: z.number().int().nonnegative().optional(),
    total_count: z.number().int().nonnegative().optional(),
  })
  .openapi("ItemsListMeta");

const ListQuery = z.object({
  filter: z.string().optional().openapi({
    description: "JSON-encoded filter DSL (Directus-style).",
  }),
  sort: z.string().optional().openapi({
    description: "Comma-separated field list; prefix `-` for DESC.",
  }),
  fields: z.string().optional().openapi({
    description: "Comma-separated projection. System fields are always included.",
  }),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  meta: z.string().optional().openapi({
    description: "`filter_count`, `total_count`, or `*`.",
  }),
  locale: z.string().optional().openapi({
    description: "Locale for i18n_text projection; `*` returns full map.",
  }),
});

const TAGS = ["items"];

export const itemsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}",
      tags: TAGS,
      summary: "List items",
      description:
        "Generic list endpoint for any collection. Supports Directus-shaped `filter`, `sort`, `fields`, `limit`, `offset`, `meta`. Item shape comes from the collection's field definitions; see the dynamic per-collection paths for typed schemas.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        query: ListQuery,
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(ItemRow),
                limit: z.number().int().nonnegative(),
                offset: z.number().int().nonnegative(),
                meta: ListMeta.optional(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const params = new URL(c.req.url).searchParams;
      const q = parseQuery(
        params,
        collection.fields,
        collection.ownerScoped,
        perm.fields,
        collection.defaultSort,
      );

      const table = collection.physicalTable;
      // User-supplied filters and permission whereSql both reference system
      // fields by their logical names (`created_at`, `owner_id`). Rewrite
      // those keys to the actual physical column before compiling so the
      // generated SQL doesn't refer to columns the source table doesn't have.
      // perm.whereSql is already compiled (we can't re-rewrite it here);
      // permissions only reference `owner_id`, and the side-table join
      // surfaces an unqualified `owner_id` so the existing perm SQL still
      // works in that case. For the alias path the workspace admin is
      // responsible for crafting permission conditions against the aliased
      // column name directly.
      const userFilter = q.filter ? rewriteSystemFieldsInCondition(q.filter, collection) : null;
      const userWhere = userFilter ? compileCondition(userFilter, auth) : null;
      const tenantWhere = tenantFilter(collection, auth);
      const wheres = [userWhere, perm.whereSql, tenantWhere].filter(
        (x): x is SQL => x != null,
      );
      const whereClause = wheres.length
        ? sql`WHERE ${sql.join(wheres, sql` AND `)}`
        : sql``;

      const projection = resolveProjection(
        q,
        collection.fields,
        collection.ownerScoped,
        perm.fields,
      );
      const selectCols: SQL = projection
        ? sql.join(
            projection.map((col) => selectColRef(collection, col)),
            sql`, `,
          )
        : selectStar(collection);

      const orderClause = sql.join(
        q.sort.map(
          (s) => sql`${sql.identifier(rewriteSortField(s.field, collection))} ${sql.raw(s.dir.toUpperCase())}`,
        ),
        sql`, `,
      );

      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectCols} FROM ${fromOf(collection)} ${whereClause} ORDER BY ${orderClause} LIMIT ${q.limit} OFFSET ${q.offset}`,
      );

      let metaOut: { filter_count?: number; total_count?: number } | undefined;
      if (q.meta.filterCount || q.meta.totalCount) {
        metaOut = {};
        if (q.meta.filterCount) {
          const r = await queryAll<{ count: number | string | bigint }>(
            ctx,
            sql`SELECT COUNT(*) AS count FROM ${fromOf(collection)} ${whereClause}`,
          );
          metaOut.filter_count = Number(r[0]?.count ?? 0);
        }
        if (q.meta.totalCount) {
          // total_count still respects tenant scoping — never leak rows from
          // sibling workspaces to the API consumer.
          const totalWhere = tenantWhere
            ? sql`WHERE ${tenantWhere}`
            : sql``;
          const r = await queryAll<{ count: number | string | bigint }>(
            ctx,
            sql`SELECT COUNT(*) AS count FROM ${fromOf(collection)} ${totalWhere}`,
          );
          metaOut.total_count = Number(r[0]?.count ?? 0);
        }
      }

      const locale = c.req.query("locale") ?? null;
      const defaultLocale =
        locale && locale !== "*" && hasI18nField(collection.fields)
          ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
          : null;
      return c.json({
        data: rows.map((r) =>
          localizeRow(
            deserializeRow(
              r,
              collection.fields,
              ctx.dialect,
              collection.ownerScoped,
              projection,
            ),
            collection.fields,
            locale,
            defaultLocale,
          ),
        ),
        limit: q.limit,
        offset: q.offset,
        ...(metaOut ? { meta: metaOut } : {}),
      });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Get item",
      description: "Fetches one row by primary key. Respects per-role read field projection.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ locale: z.string().optional() }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const table = collection.physicalTable;
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, c.req.param("id")), perm.whereSql, tenantFilter(collection, auth))} LIMIT 1`,
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
      const locale = c.req.query("locale") ?? null;
      const defaultLocale =
        locale && locale !== "*" && hasI18nField(collection.fields)
          ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
          : null;
      return c.json({
        data: projectFields(
          localizeRow(
            deserializeRow(rows[0], collection.fields, ctx.dialect, collection.ownerScoped),
            collection.fields,
            locale,
            defaultLocale,
          ),
          perm.fields,
        ),
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}",
      tags: TAGS,
      summary: "Create item",
      description:
        "Creates a row in the collection. Body shape is the collection's field map; adopted collections must include the primary key value.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "create")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ locale: z.string().optional() }),
        body: {
          required: true,
          content: { "application/json": { schema: ItemBody } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const data = (await c.req.json()) as Record<string, unknown>;
      // PK extraction MUST happen before validateBody — adopted collections
      // accept the PK in the body, but the PK isn't in `collection.fields`,
      // so validateBody would reject it as an unknown field otherwise.
      const table = collection.physicalTable;
      let id: string;
      if (collection.adopted) {
        const pkVal = data[collection.pkColumn];
        if (pkVal === undefined || pkVal === null || pkVal === "") {
          throw new AppError(
            "VALIDATION",
            `Primary key "${collection.pkColumn}" is required in the body for adopted collections`,
          );
        }
        id = String(pkVal);
        delete data[collection.pkColumn];
      } else {
        id = crypto.randomUUID();
      }
      validateBody(data, collection.fields, false, perm.fields);
      await validateRelations(data, collection.fields, ctx, auth.tenantId);
      if (hasI18nField(collection.fields)) {
        const writeLocale = c.req.query("locale") ?? null;
        mergeI18nPatch(data, {}, collection.fields, writeLocale);
      }
      const now = nowFor(ctx.dialect);

      const cols: string[] = [collection.pkColumn];
      const vals: unknown[] = [id];
      if (collection.hasCreatedAt) {
        cols.push(collection.createdAtColumn ?? "created_at");
        vals.push(now);
      }
      if (collection.hasUpdatedAt) {
        cols.push(collection.updatedAtColumn ?? "updated_at");
        vals.push(now);
      }
      // Managed owner_id column lives on the physical row; adopted collections
      // use the side-table `item_ownership` instead (written below, after the
      // row insert succeeds — see the adopted ownership branch).
      if (collection.ownerScoped && !collection.adopted) {
        cols.push("owner_id");
        vals.push(auth.userId);
      }
      if (collection.tenantScoped) {
        if (!auth.tenantId) {
          throw new AppError(
            "VALIDATION",
            "Active tenant could not be resolved; cannot insert into tenant-scoped collection",
          );
        }
        cols.push("tenant_id");
        vals.push(auth.tenantId);
      }
      for (const f of collection.fields) {
        if (data[f.name] === undefined) continue;
        cols.push(f.name);
        vals.push(serialize(data[f.name], f.type, ctx.dialect));
      }

      const colSql = sql.join(
        cols.map((n) => sql.identifier(n)),
        sql`, `,
      );
      const valSql = sql.join(
        vals.map((v) => sql`${v}`),
        sql`, `,
      );
      await execute(
        ctx,
        sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES (${valSql})`,
      );
      // Adopted owner-scoped collections carry ownership in the side table.
      // We INSERT here, post-row-insert, so a FK violation on a missing
      // collection row would fail before we wrote to the user's table.
      if (usesOwnershipSideTable(collection) && auth.userId) {
        await execute(
          ctx,
          sql`INSERT INTO ${sql.identifier("item_ownership")} (${sql.identifier("collection_id")}, ${sql.identifier("item_id")}, ${sql.identifier("owner_id")}, ${sql.identifier("created_at")})
              VALUES (${collection.id}, ${id}, ${auth.userId}, ${now})`,
        );
      }

      const out: Record<string, unknown> = { id, ...data };
      if (collection.hasCreatedAt) out.createdAt = deserialize(now, "timestamp", ctx.dialect);
      if (collection.hasUpdatedAt) out.updatedAt = deserialize(now, "timestamp", ctx.dialect);
      if (collection.ownerScoped) out.ownerId = auth.userId;
      await embedAndUpsert(
        ctx,
        collection,
        auth.tenantId ?? null,
        id,
        data,
      );
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "created", data: out },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      const projected = projectFields(out, perm.fields);
      const meta = requestMeta(c.req.raw);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "create",
          collection: collection.slug,
          itemId: id,
          ...meta,
          payload: data,
          response: { data: projected },
          durationMs: elapsedMs(c),
        },
      );
      return c.json({ data: projected }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Update item",
      description:
        "Partial update. `i18n_text` fields merge into the existing locale map; pass `?locale=xx` with a string value to upsert one locale.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ locale: z.string().optional() }),
        body: {
          required: true,
          content: { "application/json": { schema: ItemBody } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const id = c.req.param("id");
      const patch = (await c.req.json()) as Record<string, unknown>;
      validateBody(patch, collection.fields, true, perm.fields);
      await validateRelations(patch, collection.fields, ctx, auth.tenantId);

      const table = collection.physicalTable;
      const tenantWhere = tenantFilter(collection, auth);
      const existing = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)} LIMIT 1`,
      );
      if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
      const beforeRow = deserializeRow(
        existing[0],
        collection.fields,
        ctx.dialect,
        collection.ownerScoped,
      );

      if (hasI18nField(collection.fields)) {
        const writeLocale = c.req.query("locale") ?? null;
        mergeI18nPatch(patch, beforeRow, collection.fields, writeLocale);
      }

      const now = nowFor(ctx.dialect);
      const sets: SQL[] = [];
      if (collection.hasUpdatedAt) {
        sets.push(sql`${sql.identifier(collection.updatedAtColumn ?? "updated_at")} = ${now}`);
      }
      for (const f of collection.fields) {
        if (patch[f.name] === undefined) continue;
        sets.push(
          sql`${sql.identifier(f.name)} = ${serialize(patch[f.name], f.type, ctx.dialect)}`,
        );
      }

      // If nothing to update (no updated_at + no field patches), skip the UPDATE
      // entirely — emitting `SET ` with no clauses is a syntax error.
      if (sets.length > 0) {
        await execute(
          ctx,
          sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
        );
      }

      const refreshed = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), tenantWhere)} LIMIT 1`,
      );
      const refreshedRow = deserializeRow(
        refreshed[0]!,
        collection.fields,
        ctx.dialect,
        collection.ownerScoped,
      );
      await embedAndUpsert(
        ctx,
        collection,
        auth.tenantId ?? null,
        id,
        refreshedRow,
      );
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "updated", data: refreshedRow },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      const projected = projectFields(refreshedRow, perm.fields);
      const meta = requestMeta(c.req.raw);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "update",
          collection: collection.slug,
          itemId: id,
          ...meta,
          payload: patch,
          response: { data: projected },
          durationMs: elapsedMs(c),
        },
      );
      await recordRevision(
        { db: ctx.db, dialect: ctx.dialect },
        {
          collection: collection.slug,
          itemId: id,
          snapshot: beforeRow,
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
        },
      );
      return c.json({ data: projected });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Delete item",
      description: "Hard-deletes the row. Cascades to ownership side table + vector store.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "delete")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
      },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const id = c.req.param("id");
      const table = collection.physicalTable;
      const tenantWhere = tenantFilter(collection, auth);

      const existing = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)} LIMIT 1`,
      );
      if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
      const oldRow = deserializeRow(
        existing[0],
        collection.fields,
        ctx.dialect,
        collection.ownerScoped,
      );

      await execute(
        ctx,
        sql`DELETE FROM ${sql.identifier(table)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
      );
      // Cascade-clean the ownership side table for adopted owner-scoped rows.
      // No-op for everyone else (the row simply doesn't exist there).
      if (usesOwnershipSideTable(collection)) {
        await execute(
          ctx,
          sql`DELETE FROM ${sql.identifier("item_ownership")}
              WHERE ${sql.identifier("collection_id")} = ${collection.id}
              AND ${sql.identifier("item_id")} = ${id}`,
        );
      }
      await deleteVector(ctx, collection, id);
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "deleted", data: oldRow },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      const meta = requestMeta(c.req.raw);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "delete",
          collection: collection.slug,
          itemId: id,
          ...meta,
          payload: oldRow,
          response: { ok: true },
          durationMs: elapsedMs(c),
        },
      );
      await recordRevision(
        { db: ctx.db, dialect: ctx.dialect },
        {
          collection: collection.slug,
          itemId: id,
          snapshot: oldRow,
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
        },
      );
      return c.json({ ok: true });
    },
  )
  /**
   * Flip a versioned-collection row from `_status='draft'` to `'published'`
   * (or vice versa with `?unpublish=1`). Requires the caller to have
   * `update` permission on the collection.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/{id}/publish",
      tags: TAGS,
      summary: "Publish or unpublish a versioned item",
      description:
        "Versioned-collection only. Flips `_status` between `draft` and `published`; pass `?unpublish=1` to revert.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ unpublish: z.enum(["1"]).optional() }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      if (!collection.versioned) {
        throw new AppError(
          "VALIDATION",
          "Collection is not versioned — set `versioned: true` on the collection first",
        );
      }
      const id = c.req.param("id");
      const table = collection.physicalTable;
      const tenantWhere = tenantFilter(collection, auth);
      const unpublish = c.req.query("unpublish") === "1";
      const now = nowFor(ctx.dialect);
      const setSql = unpublish
        ? sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`
        : sql`${sql.identifier("_status")} = 'published', ${sql.identifier("_published_at")} = ${now}, ${sql.identifier("updated_at")} = ${now}`;
      await execute(
        ctx,
        sql`UPDATE ${sql.identifier(table)} SET ${setSql} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
      );
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)} LIMIT 1`,
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
      const after = deserializeRow(rows[0], collection.fields, ctx.dialect, collection.ownerScoped);
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: unpublish ? "unpublished" : "published", data: after },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      return c.json({ data: after });
    },
  );
