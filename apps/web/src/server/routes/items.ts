import { Hono } from "hono";
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
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import type { Ctx } from "../context";
import { parseQuery, resolveProjection } from "../lib/query";
import { publishEvent } from "../services/events";
import { elapsedMs, keepAlive, recordActivity, requestMeta } from "../services/activity";
import { recordRevision } from "../services/revisions";
import { embedAndUpsert, deleteVector } from "../services/vectorize";
import { loadAppSettings } from "../services/settings";

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

const execute = async (ctx: Ctx, query: unknown): Promise<unknown> => {
  if (ctx.dialect === "pg") return (ctx.db as any).execute(query);
  return (ctx.db as any).run(query);
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

import type { Context } from "hono";
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
 * Whether this collection's `owner_id` lives in the side table rather than
 * on the physical row. The two-pronged check is essentially the contract:
 * adopted collections never had an `owner_id` column injected (the
 * schema-applier is a no-op for them), so when they're also owner-scoped,
 * ownership must come from `item_ownership` via a join.
 */
const usesOwnershipSideTable = (collection: CollectionRow): boolean =>
  collection.adopted && collection.ownerScoped;

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
 * `SELECT *` replacement that disambiguates column lists when the join is
 * active — we explicitly pull `<physical>.*` plus the qualified
 * `item_ownership.owner_id` so two `created_at` columns (one on each side)
 * don't collide in the result set.
 */
const selectStar = (collection: CollectionRow): SQL => {
  if (!usesOwnershipSideTable(collection)) return sql`*`;
  const tbl = sql.identifier(collection.physicalTable);
  return sql`${tbl}.*, ${sql.identifier("item_ownership")}.${sql.identifier("owner_id")} AS ${sql.identifier("owner_id")}`;
};

/** Build a single column reference for the SELECT list, qualifying
 *  `owner_id` to the side-table when needed. */
const selectColRef = (collection: CollectionRow, col: string): SQL => {
  if (col === "owner_id" && usesOwnershipSideTable(collection)) {
    return sql`${sql.identifier("item_ownership")}.${sql.identifier("owner_id")} AS ${sql.identifier("owner_id")}`;
  }
  return sql`${sql.identifier(col)}`;
};

export const itemsRoutes = new Hono<AppBindings>()
  .get("/:slug", requirePermission(collectionFromParam, "read"), async (c) => {
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
    const userWhere = q.filter ? compileCondition(q.filter, auth) : null;
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
        (s) => sql`${sql.identifier(s.field)} ${sql.raw(s.dir.toUpperCase())}`,
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
  })
  .get("/:slug/:id", requirePermission(collectionFromParam, "read"), async (c) => {
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
  })
  .post("/:slug", requirePermission(collectionFromParam, "create"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
    const data = (await c.req.json()) as Record<string, unknown>;
    validateBody(data, collection.fields, false, perm.fields);
    if (hasI18nField(collection.fields)) {
      const writeLocale = c.req.query("locale") ?? null;
      mergeI18nPatch(data, {}, collection.fields, writeLocale);
    }

    const table = collection.physicalTable;
    // PK generation: managed collections always synthesize a UUID; adopted
    // collections must receive the PK in the request body (we can't guess
    // the user's PK type — could be uuid, int, custom slug…).
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
    const now = nowFor(ctx.dialect);

    const cols: string[] = [collection.pkColumn];
    const vals: unknown[] = [id];
    if (collection.hasCreatedAt) {
      cols.push("created_at");
      vals.push(now);
    }
    if (collection.hasUpdatedAt) {
      cols.push("updated_at");
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
  })
  .patch("/:slug/:id", requirePermission(collectionFromParam, "update"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
    const id = c.req.param("id");
    const patch = (await c.req.json()) as Record<string, unknown>;
    validateBody(patch, collection.fields, true, perm.fields);

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
      sets.push(sql`${sql.identifier("updated_at")} = ${now}`);
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
  })
  .delete("/:slug/:id", requirePermission(collectionFromParam, "delete"), async (c) => {
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
  })
  /**
   * Flip a versioned-collection row from `_status='draft'` to `'published'`
   * (or vice versa with `?unpublish=1`). Requires the caller to have
   * `update` permission on the collection.
   */
  .post("/:slug/:id/publish", requirePermission(collectionFromParam, "update"), async (c) => {
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
  });
