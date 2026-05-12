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

interface CollectionRow {
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
    slug: r.slug as string,
    physicalTable: (r.physicalTable ?? r.physical_table) as string,
    fields: r.fields as FieldDef[],
    ownerScoped: Boolean(r.ownerScoped ?? r.owner_scoped),
    tenantScoped: r.tenantScoped ?? r.tenant_scoped ?? true ? true : false,
    versioned: Boolean(r.versioned),
    vectorize: Boolean(r.vectorize),
    vectorizeModel: ((r.vectorizeModel ?? r.vectorize_model) as string | null | undefined) ?? null,
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
    if (type === "json" || type === "relation_many") {
      // relation_many is an array of foreign ids — store as JSON text on
      // SQLite so the same column pattern as `json` works (no native array).
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
    if (type === "json" || type === "relation_many") {
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
): Record<string, unknown> => {
  const includeAll = !projection;
  const sel = new Set(projection ?? []);
  const out: Record<string, unknown> = {};
  if (includeAll || sel.has("id")) out.id = row.id;
  if (includeAll || sel.has("created_at"))
    out.createdAt = deserialize(row.created_at, "timestamp", dialect);
  if (includeAll || sel.has("updated_at"))
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

const localizeRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  locale: string | null,
): Record<string, unknown> => {
  if (!locale) return row;
  for (const f of fields) {
    if (f.type !== "i18n_text") continue;
    const v = row[f.name];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const map = v as Record<string, unknown>;
      const picked = map[locale] ?? Object.values(map)[0] ?? null;
      row[f.name] = picked;
    }
  }
  return row;
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

const idEq = (id: string): SQL =>
  sql`${sql.identifier("id")} = ${id}`;

export const itemsRoutes = new Hono<AppBindings>()
  .get("/:slug", requirePermission(collectionFromParam, "read"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
    const params = new URL(c.req.url).searchParams;
    const q = parseQuery(params, collection.fields, collection.ownerScoped, perm.fields);

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
          projection.map((col) => sql.identifier(col)),
          sql`, `,
        )
      : sql`*`;

    const orderClause = sql.join(
      q.sort.map(
        (s) => sql`${sql.identifier(s.field)} ${sql.raw(s.dir.toUpperCase())}`,
      ),
      sql`, `,
    );

    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${selectCols} FROM ${sql.identifier(table)} ${whereClause} ORDER BY ${orderClause} LIMIT ${q.limit} OFFSET ${q.offset}`,
    );

    let metaOut: { filter_count?: number; total_count?: number } | undefined;
    if (q.meta.filterCount || q.meta.totalCount) {
      metaOut = {};
      if (q.meta.filterCount) {
        const r = await queryAll<{ count: number | string | bigint }>(
          ctx,
          sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)} ${whereClause}`,
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
          sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)} ${totalWhere}`,
        );
        metaOut.total_count = Number(r[0]?.count ?? 0);
      }
    }

    const locale = c.req.query("locale") ?? null;
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
      sql`SELECT * FROM ${sql.identifier(table)} ${whereOf(idEq(c.req.param("id")), perm.whereSql, tenantFilter(collection, auth))} LIMIT 1`,
    );
    if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
    const locale = c.req.query("locale") ?? null;
    return c.json({
      data: projectFields(
        localizeRow(
          deserializeRow(rows[0], collection.fields, ctx.dialect, collection.ownerScoped),
          collection.fields,
          locale,
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

    const table = collection.physicalTable;
    const id = crypto.randomUUID();
    const now = nowFor(ctx.dialect);

    const cols: string[] = ["id", "created_at", "updated_at"];
    const vals: unknown[] = [id, now, now];
    if (collection.ownerScoped) {
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

    const out: Record<string, unknown> = {
      id,
      createdAt: deserialize(now, "timestamp", ctx.dialect),
      updatedAt: deserialize(now, "timestamp", ctx.dialect),
      ...data,
    };
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
        durationMs: elapsedMs(c),
      },
    );
    return c.json({ data: projectFields(out, perm.fields) }, 201);
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
      sql`SELECT * FROM ${sql.identifier(table)} ${whereOf(idEq(id), perm.whereSql, tenantWhere)} LIMIT 1`,
    );
    if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
    const beforeRow = deserializeRow(
      existing[0],
      collection.fields,
      ctx.dialect,
      collection.ownerScoped,
    );

    const now = nowFor(ctx.dialect);
    const sets: SQL[] = [
      sql`${sql.identifier("updated_at")} = ${now}`,
    ];
    for (const f of collection.fields) {
      if (patch[f.name] === undefined) continue;
      sets.push(
        sql`${sql.identifier(f.name)} = ${serialize(patch[f.name], f.type, ctx.dialect)}`,
      );
    }

    await execute(
      ctx,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} ${whereOf(idEq(id), perm.whereSql, tenantWhere)}`,
    );

    const refreshed = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${sql.identifier(table)} ${whereOf(idEq(id), tenantWhere)} LIMIT 1`,
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
    return c.json({ data: projectFields(refreshedRow, perm.fields) });
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
      sql`SELECT * FROM ${sql.identifier(table)} ${whereOf(idEq(id), perm.whereSql, tenantWhere)} LIMIT 1`,
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
      sql`DELETE FROM ${sql.identifier(table)} ${whereOf(idEq(id), perm.whereSql, tenantWhere)}`,
    );
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
      sql`UPDATE ${sql.identifier(table)} SET ${setSql} ${whereOf(idEq(id), perm.whereSql, tenantWhere)}`,
    );
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${sql.identifier(table)} ${whereOf(idEq(id), perm.whereSql, tenantWhere)} LIMIT 1`,
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
