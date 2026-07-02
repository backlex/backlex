import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  type GraphQLFieldConfig,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";
import { sql, type SQL } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  compileCondition,
  type FieldDef,
  type FieldType,
} from "@backlex/db";
import {
  AppError,
  type AuthSubject,
  type Condition,
  normalizeCondition,
} from "@backlex/core";
import {
  resolvePermission,
  type PermResolveCache,
} from "../permissions";
import { publishEvent } from "../events";
import { loadCollection } from "../items/collection-loader";
import { runBatch, type BatchOp } from "../items/batch";
import { runBulkUpdate } from "../items/bulk";
import type { Hono } from "hono";
import type { Ctx } from "../../context";

export interface CollectionRow {
  slug: string;
  physicalTable: string;
  fields: FieldDef[];
  ownerScoped: boolean | number;
  pkColumn: string;
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
  softDelete: boolean;
  singleton: boolean;
  versioned: boolean;
  /** Whether the physical table carries a `tenant_id` column scoping rows per
   *  workspace. Managed collections get a per-tenant physical table so the name
   *  itself isolates, but adopted+tenant-scoped collections share one table and
   *  rely ENTIRELY on `tenant_id = $auth.tenantId` for isolation — every
   *  resolver below must AND in `gqlTenantWhere` exactly like the REST path's
   *  `tenantFilter`. Omitting it leaks rows across workspaces. */
  tenantScoped: boolean;
}

export interface GqlCtx {
  ctx: Ctx;
  auth: AuthSubject;
  /** Per-request L1 permission cache, threaded through every resolver so a
   *  single GraphQL query doesn't re-resolve the same (collection, action)
   *  pair across `list`/`get`/sub-selections. Populated by the GraphQL
   *  route via `getRequestPermCache(c)`. */
  permCache?: PermResolveCache;
  /** Parent Hono app + the original request — set only so the `runAgent`
   *  mutation can build an in-process sub-fetch (carrying the caller's
   *  identity) to execute the agent's allow-listed MCP tools, exactly like the
   *  REST route does. Absent on schema builds that never run an agent. */
  app?: Hono;
  rawRequest?: Request;
  /** Per-request batch loaders for to-one `relation` field resolution, keyed
   *  by TARGET collection slug. Coalesces the per-row `WHERE id = ?` lookups a
   *  list of N parents would otherwise fire (the classic GraphQL N+1) into one
   *  `WHERE id IN (…)` per target. MUST be per-request — never module-global —
   *  or one tenant's loader could serve another's rows. Lazily created. */
  relationLoaders?: Map<string, RelationLoader>;
}

/** A minimal DataLoader: `load(id)` queues the id, a microtask flushes the
 *  whole queue as one batched fetch, and same-id loads in a request dedupe. */
interface RelationLoader {
  load(id: string): Promise<unknown>;
}

export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description:
    "Arbitrary JSON. Pass as a variable; inline literals not supported.",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: () => {
    throw new GraphQLError(
      "JSON literal not supported; pass as a variable instead.",
    );
  },
});

export const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

export const pascal = (s: string): string =>
  s.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());

export const camel = (s: string): string =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const fieldScalar = (
  type: FieldType,
): GraphQLOutputType & GraphQLInputType => {
  switch (type) {
    case "text":
    case "longtext":
    case "uuid":
    case "timestamp":
      return GraphQLString;
    case "integer":
      return GraphQLInt;
    case "number":
      return GraphQLFloat;
    case "boolean":
      return GraphQLBoolean;
    case "json":
      return JSONScalar;
    case "relation":
    case "file":
      // Input + raw output (when target type isn't in registry): the foreign id.
      return GraphQLID;
    case "relation_many":
      // Array of foreign ids — exposed as a JSON list for now (avoids
      // tight typing complications with mutations until DataLoader lands).
      return JSONScalar;
    case "i18n_text":
      // {locale: value} map exposed verbatim. Locale-aware projection
      // happens at the REST resolver via `?locale=`.
      return JSONScalar;
  }
};

const fieldGqlType = (f: FieldDef): GraphQLOutputType => {
  const t = fieldScalar(f.type);
  return f.required ? new GraphQLNonNull(t) : t;
};

export const buildCollectionType = (
  collection: CollectionRow,
  collections: CollectionRow[],
  registry: Map<string, GraphQLObjectType>,
): GraphQLObjectType => {
  return new GraphQLObjectType({
    name: pascal(collection.slug),
    fields: () => {
      const fields: Record<
        string,
        {
          type: GraphQLOutputType;
          resolve?: GraphQLFieldConfig<unknown, GqlCtx>["resolve"];
        }
      > = {
        id: { type: new GraphQLNonNull(GraphQLID) },
        createdAt: { type: new GraphQLNonNull(GraphQLString) },
        updatedAt: { type: new GraphQLNonNull(GraphQLString) },
      };
      if (collection.ownerScoped) {
        fields.ownerId = { type: GraphQLString };
      }
      for (const f of collection.fields) {
        if (f.type === "relation" && f.to) {
          const target = registry.get(f.to);
          const targetCollection = collections.find((c) => c.slug === f.to);
          if (target && targetCollection) {
            // Resolve the related row through the per-request batch loader so
            // a list of N parents fires ONE `WHERE id IN (…)` for this target
            // instead of N single-row lookups (the GraphQL N+1).
            const fieldKey = camel(f.name);
            fields[fieldKey] = {
              type: f.required ? new GraphQLNonNull(target) : target,
              resolve: (parent, _args, gqlCtx) => {
                const idValue = (parent as Record<string, unknown>)[fieldKey];
                if (!idValue || typeof idValue !== "string") return null;
                return getRelationLoader(gqlCtx, targetCollection).load(idValue);
              },
            };
            continue;
          }
        }
        fields[camel(f.name)] = { type: fieldGqlType(f) };
      }
      return fields;
    },
  });
};

export const buildInputType = (collection: CollectionRow): GraphQLInputObjectType => {
  return new GraphQLInputObjectType({
    name: `${pascal(collection.slug)}Input`,
    fields: () => {
      const fields: Record<string, { type: GraphQLInputType }> = {};
      for (const f of collection.fields) {
        // All fields optional in input — server-side validates required-ness.
        fields[camel(f.name)] = { type: fieldScalar(f.type) };
      }
      // GraphQL requires at least one input field. A collection with no
      // user-defined fields would otherwise fail the entire schema build —
      // emit a placeholder field that's documented as "no-op".
      if (Object.keys(fields).length === 0) {
        fields._empty = {
          type: GraphQLBoolean,
        };
      }
      return fields;
    },
  });
};

const serialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value === undefined || value === null) return null;
  if (dialect === "sqlite") {
    if (type === "json") return JSON.stringify(value);
    if (type === "boolean") return value ? 1 : 0;
    if (type === "timestamp") {
      return value instanceof Date ? value.getTime() : Number(value);
    }
  } else {
    if (type === "timestamp" && !(value instanceof Date)) {
      return new Date(value as string | number);
    }
  }
  return value;
};

const execute = async (ctx: Ctx, query: SQL): Promise<unknown> => {
  if (ctx.dialect === "pg") return (ctx.db as any).execute(query);
  return (ctx.db as any).run(query);
};

const fieldByCamel = (collection: CollectionRow, camelName: string): FieldDef | undefined =>
  collection.fields.find((f) => camel(f.name) === camelName);

const validateInput = (
  inputData: Record<string, unknown>,
  collection: CollectionRow,
  perm: Awaited<ReturnType<typeof resolvePermission>>,
  partial: boolean,
): void => {
  for (const f of collection.fields) {
    if (
      f.required &&
      !partial &&
      (inputData[camel(f.name)] === undefined ||
        inputData[camel(f.name)] === null)
    ) {
      throw new GraphQLError(`Field "${f.name}" is required`, {
        extensions: { code: "VALIDATION" },
      });
    }
  }
  for (const k of Object.keys(inputData)) {
    const f = fieldByCamel(collection, k);
    if (!f) {
      throw new GraphQLError(`Unknown field: ${k}`, {
        extensions: { code: "VALIDATION" },
      });
    }
    if (perm.fields && !perm.fields.has(f.name)) {
      throw new GraphQLError(`No permission to write field "${k}"`, {
        extensions: { code: "FORBIDDEN" },
      });
    }
  }
};

const queryAll = async <T>(ctx: Ctx, query: SQL): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = (await (ctx.db as any).execute(query)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return (r as { rows: T[] }).rows;
    return r as T[];
  }
  return (await (ctx.db as any).all(query)) as T[];
};

const deserialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value == null) return value;
  if (dialect === "sqlite") {
    if (type === "json") {
      return typeof value === "string" ? JSON.parse(value) : value;
    }
    if (type === "boolean") return Boolean(value);
    if (type === "timestamp") return new Date(value as number).toISOString();
  }
  return value;
};

const renderRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  dialect: "pg" | "sqlite",
  ownerScoped: boolean,
  hasCreatedAt = true,
  hasUpdatedAt = true,
  /** Read field allow-list from the caller's permission grant. When non-null,
   *  only these field names are rendered — mirrors REST's `projectFields` so the
   *  GraphQL read path enforces the same field-level ACL (system keys id/
   *  createdAt/updatedAt/ownerId are always kept). A dropped relation FK also
   *  makes its nested resolver return null, since the parent loses that key. */
  allowedFields: Set<string> | null = null,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { id: row.id };
  if (hasCreatedAt) out.createdAt = deserialize(row.created_at, "timestamp", dialect);
  if (hasUpdatedAt) out.updatedAt = deserialize(row.updated_at, "timestamp", dialect);
  if (ownerScoped) out.ownerId = row.owner_id ?? null;
  for (const f of fields) {
    if (allowedFields && !allowedFields.has(f.name)) continue;
    out[camel(f.name)] = deserialize(row[f.name], f.type, dialect);
  }
  return out;
};

const buildOrderClause = (
  sortStr: string | undefined,
  collection: CollectionRow,
): SQL => {
  // Default sort needs a column that exists: created_at when the collection
  // has it, otherwise the primary key (timestamps-off collections).
  const fallback = collection.hasCreatedAt
    ? sql`ORDER BY ${sql.identifier("created_at")} DESC`
    : sql`ORDER BY ${sql.identifier(collection.pkColumn)} DESC`;
  if (!sortStr) return fallback;
  // Allow-list of sortable columns: system columns + the collection's own
  // fields. An unknown column is dropped rather than spliced into the query —
  // this stops ORDER BY against columns outside the schema (a 500 / probing
  // oracle) even though `sql.identifier` already prevents SQL break-out.
  const sortable = new Set<string>([
    "id",
    collection.pkColumn,
    ...(collection.hasCreatedAt ? ["created_at"] : []),
    ...(collection.hasUpdatedAt ? ["updated_at"] : []),
    // Versioned collections can order by publish date / status (REST parity).
    ...(collection.versioned ? ["_status", "_published_at", "_publish_at"] : []),
    ...collection.fields.map((f) => f.name),
  ]);
  const parts = sortStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const dir: "ASC" | "DESC" = s.startsWith("-") ? "DESC" : "ASC";
      const field = s.replace(/^[-+]/, "");
      if (!sortable.has(field)) return null;
      return sql`${sql.identifier(field)} ${sql.raw(dir)}`;
    })
    .filter((x): x is SQL => x != null);
  return parts.length === 0 ? fallback : sql`ORDER BY ${sql.join(parts, sql`, `)}`;
};

/** Tenant-isolation predicate, mirroring the REST `tenantFilter`. Returns null
 *  for non-tenant-scoped collections (the physical table name already isolates,
 *  or it's legacy/system data); `(1=0)` when scoped but the caller has no
 *  tenant (fail-closed). Every read/write resolver AND-s this into its WHERE so
 *  GraphQL never depends on `perm.whereSql` alone for cross-tenant isolation. */
const gqlTenantWhere = (
  collection: CollectionRow,
  auth: AuthSubject,
): SQL | null => {
  if (!collection.tenantScoped) return null;
  if (!auth.tenantId) return sql`(1=0)`;
  return sql`${sql.identifier("tenant_id")} = ${auth.tenantId}`;
};

const denyOrThrow = (auth: AuthSubject, slug: string) => {
  throw new GraphQLError(
    auth.userId
      ? `No read permission for ${slug}`
      : "Sign in required",
    { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
  );
};

/** Published-only filter for versioned collections unless the caller can see
 *  drafts (admin or holds publish/update). Mirrors the REST `draftFilter`.
 *  GraphQL has no `?status` param, so privileged callers see all (and can still
 *  filter on `_status` via the query filter DSL). */
const gqlDraftWhere = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  perm: { isAdmin?: boolean },
): Promise<SQL | null> => {
  if (!collection.versioned) return null;
  if (perm.isAdmin) return null;
  const { ctx, auth, permCache } = gqlCtx;
  const canSee =
    (await resolvePermission(ctx, auth, collection.slug, "publish", permCache)).allowed ||
    (await resolvePermission(ctx, auth, collection.slug, "update", permCache)).allowed;
  return canSee ? null : sql`${sql.identifier("_status")} = 'published'`;
};

export const listResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { filter?: Condition; sort?: string; limit?: number; offset?: number },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) denyOrThrow(auth, collection.slug);

  const table = collection.physicalTable;
  // Normalize the same accepted input shapes as REST (`_and` aliases,
  // nested-object relation filters, implicit-equality) before compiling.
  const relationFields = new Set(
    collection.fields
      .filter((f) => f.type === "relation" || f.type === "relation_many")
      .map((f) => f.name),
  );
  const userWhere = args.filter
    ? compileCondition(
        normalizeCondition(args.filter, { relationFields }),
        auth,
        undefined,
        undefined,
        { dialect: ctx.dialect },
      )
    : null;
  // Hide soft-deleted rows (column is always `deleted_at`; managed-only).
  const deletedWhere = collection.softDelete
    ? sql`${sql.identifier("deleted_at")} IS NULL`
    : null;
  const draftWhere = await gqlDraftWhere(gqlCtx, collection, perm);
  const wheres = [
    gqlTenantWhere(collection, auth),
    userWhere,
    perm.whereSql,
    deletedWhere,
    draftWhere,
  ].filter((x): x is SQL => x != null);
  const whereClause = wheres.length
    ? sql`WHERE ${sql.join(wheres, sql` AND `)}`
    : sql``;
  const orderClause = buildOrderClause(args.sort, collection);
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  const offset = Math.max(0, args.offset ?? 0);

  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} ${whereClause} ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
  );
  return rows.map((r) =>
    renderRow(
      r,
      collection.fields,
      ctx.dialect,
      !!collection.ownerScoped,
      collection.hasCreatedAt,
      collection.hasUpdatedAt,
      perm.fields,
    ),
  );
};

/**
 * Build a per-request batch loader for one target collection. Every `.load(id)`
 * call within the same microtask is coalesced into a single
 * `SELECT * … WHERE id IN (…)`, applying the EXACT same gates as {@link
 * getResolver} (read permission, tenant scope, row-level `perm.whereSql`,
 * soft-delete, draft visibility, field projection) — only the round-trip count
 * changes. This kills the N+1 a query like `{ posts { author { name } } }`
 * would otherwise cause (one author lookup per post).
 */
const makeRelationLoader = (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
): RelationLoader => {
  type Pending = {
    id: string;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };
  let queue: Pending[] = [];
  let scheduled = false;
  // Dedupe identical ids within a request: the promise is cached so the same
  // FK referenced by many parents resolves once.
  const cache = new Map<string, Promise<unknown>>();

  const flush = async () => {
    const batch = queue;
    queue = [];
    scheduled = false;
    try {
      const { ctx, auth, permCache } = gqlCtx;
      const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
      if (!perm.allowed) denyOrThrow(auth, collection.slug); // always throws
      const ids = [...new Set(batch.map((b) => b.id))];
      const table = collection.physicalTable;
      const wheres: SQL[] = [
        sql`${sql.identifier("id")} IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      ];
      const tenantWhere = gqlTenantWhere(collection, auth);
      if (tenantWhere) wheres.push(tenantWhere);
      if (perm.whereSql) wheres.push(perm.whereSql);
      if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
      const draftWhere = await gqlDraftWhere(gqlCtx, collection, perm);
      if (draftWhere) wheres.push(draftWhere);
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)}`,
      );
      const byId = new Map<string, unknown>();
      for (const r of rows) {
        byId.set(
          String(r.id),
          renderRow(
            r,
            collection.fields,
            ctx.dialect,
            !!collection.ownerScoped,
            collection.hasCreatedAt,
            collection.hasUpdatedAt,
            perm.fields,
          ),
        );
      }
      // A row filtered out by permission/tenant/draft simply isn't in the map →
      // null, exactly as the single-row getResolver would return.
      for (const item of batch) item.resolve(byId.get(item.id) ?? null);
    } catch (e) {
      for (const item of batch) item.reject(e);
    }
  };

  return {
    load: (id: string) => {
      const hit = cache.get(id);
      if (hit) return hit;
      const p = new Promise<unknown>((resolve, reject) => {
        queue.push({ id, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
      cache.set(id, p);
      return p;
    },
  };
};

const getRelationLoader = (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
): RelationLoader => {
  const loaders = (gqlCtx.relationLoaders ??= new Map());
  let loader = loaders.get(collection.slug);
  if (!loader) {
    loader = makeRelationLoader(gqlCtx, collection);
    loaders.set(collection.slug, loader);
  }
  return loader;
};

export const getResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  id: string,
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) denyOrThrow(auth, collection.slug);

  const table = collection.physicalTable;
  const wheres: SQL[] = [sql`${sql.identifier("id")} = ${id}`];
  const tenantWhere = gqlTenantWhere(collection, auth);
  if (tenantWhere) wheres.push(tenantWhere);
  if (perm.whereSql) wheres.push(perm.whereSql);
  if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
  const draftWhere = await gqlDraftWhere(gqlCtx, collection, perm);
  if (draftWhere) wheres.push(draftWhere);
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
  );
  if (!rows[0]) return null;
  return renderRow(
    rows[0],
    collection.fields,
    ctx.dialect,
    !!collection.ownerScoped,
    collection.hasCreatedAt,
    collection.hasUpdatedAt,
    perm.fields,
  );
};

export const createResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { data: Record<string, unknown> },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "create", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No create permission for ${collection.slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  validateInput(args.data, collection, perm, false);

  const table = collection.physicalTable;

  // Singleton: reject when a live row already exists (scoped by tenant + the
  // caller's read permission, ignoring soft-deleted rows).
  if (collection.singleton) {
    const guardWheres = [
      gqlTenantWhere(collection, auth),
      perm.whereSql,
      collection.softDelete ? sql`${sql.identifier("deleted_at")} IS NULL` : null,
    ].filter((x): x is SQL => x != null);
    const guardClause = guardWheres.length
      ? sql`WHERE ${sql.join(guardWheres, sql` AND `)}`
      : sql``;
    const existingOne = await queryAll<{ one: number }>(
      ctx,
      sql`SELECT 1 AS one FROM ${sql.identifier(table)} ${guardClause} LIMIT 1`,
    );
    if (existingOne[0]) {
      throw new GraphQLError(
        "This collection is a singleton and already has a row",
        { extensions: { code: "VALIDATION" } },
      );
    }
  }

  const id = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();

  const cols: string[] = ["id"];
  const vals: unknown[] = [id];
  if (collection.hasCreatedAt) {
    cols.push("created_at");
    vals.push(now);
  }
  if (collection.hasUpdatedAt) {
    cols.push("updated_at");
    vals.push(now);
  }
  if (collection.ownerScoped) {
    cols.push("owner_id");
    vals.push(auth.userId);
  }
  // Stamp tenant_id on tenant-scoped (incl. adopted shared) tables so the row
  // is owned by the caller's workspace — mirrors the REST write path. Without
  // this a GraphQL-created row would be tenant-less and invisible/leaky.
  if (collection.tenantScoped) {
    if (!auth.tenantId) {
      throw new GraphQLError("No tenant context for a tenant-scoped collection", {
        extensions: { code: "FORBIDDEN" },
      });
    }
    cols.push("tenant_id");
    vals.push(auth.tenantId);
  }
  for (const f of collection.fields) {
    const v = args.data[camel(f.name)];
    if (v === undefined) continue;
    cols.push(f.name);
    vals.push(serialize(v, f.type, ctx.dialect));
  }
  const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
  const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
  await execute(
    ctx,
    sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES (${valSql})`,
  );

  const nowIso =
    ctx.dialect === "pg"
      ? (now as Date).toISOString()
      : new Date(now as number).toISOString();
  const out: Record<string, unknown> = { id };
  if (collection.hasCreatedAt) out.createdAt = nowIso;
  if (collection.hasUpdatedAt) out.updatedAt = nowIso;
  if (collection.ownerScoped) out.ownerId = auth.userId;
  for (const f of collection.fields) {
    const v = args.data[camel(f.name)];
    out[camel(f.name)] = v ?? null;
  }
  await publishEvent(
    ctx.env,
    `items:${collection.slug}`,
    { event: "created", data: out },
    { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
  );
  return out;
};

export const updateResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { id: string; data: Record<string, unknown> },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "update", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No update permission for ${collection.slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  validateInput(args.data, collection, perm, true);

  const table = collection.physicalTable;
  const wheres: SQL[] = [sql`${sql.identifier("id")} = ${args.id}`];
  const tenantWhere = gqlTenantWhere(collection, auth);
  if (tenantWhere) wheres.push(tenantWhere);
  if (perm.whereSql) wheres.push(perm.whereSql);
  if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
  );
  if (!existing[0]) {
    throw new GraphQLError("Item not found", { extensions: { code: "NOT_FOUND" } });
  }

  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  // Only stamp updated_at when the collection has it; skip the UPDATE entirely
  // if there's nothing to set (no timestamp + no changed fields → empty SET).
  const sets: SQL[] = collection.hasUpdatedAt
    ? [sql`${sql.identifier("updated_at")} = ${now}`]
    : [];
  for (const f of collection.fields) {
    const v = args.data[camel(f.name)];
    if (v === undefined) continue;
    sets.push(sql`${sql.identifier(f.name)} = ${serialize(v, f.type, ctx.dialect)}`);
  }
  if (sets.length > 0) {
    await execute(
      ctx,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.join(wheres, sql` AND `)}`,
    );
  }

  const refreshed = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier("id")} = ${args.id} LIMIT 1`,
  );
  // Full (unprojected) row feeds the realtime event — the event renderer
  // re-projects per subscriber's own read allow-list downstream.
  const refreshedRow = renderRow(
    refreshed[0]!,
    collection.fields,
    ctx.dialect,
    !!collection.ownerScoped,
    collection.hasCreatedAt,
    collection.hasUpdatedAt,
  );
  await publishEvent(
    ctx.env,
    `items:${collection.slug}`,
    { event: "updated", data: refreshedRow },
    { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
  );
  // The value returned to the mutating caller must respect their READ field
  // allow-list (the `update` grant may permit writing fields they can't read).
  // Mirrors REST, which renders mutation responses through the read projection.
  const readPerm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  return renderRow(
    refreshed[0]!,
    collection.fields,
    ctx.dialect,
    !!collection.ownerScoped,
    collection.hasCreatedAt,
    collection.hasUpdatedAt,
    readPerm.allowed ? readPerm.fields : new Set<string>(),
  );
};

export const deleteResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { id: string },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "delete", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No delete permission for ${collection.slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  const table = collection.physicalTable;
  const wheres: SQL[] = [sql`${sql.identifier("id")} = ${args.id}`];
  const tenantWhere = gqlTenantWhere(collection, auth);
  if (tenantWhere) wheres.push(tenantWhere);
  if (perm.whereSql) wheres.push(perm.whereSql);
  // Already-soft-deleted rows are a clean "not found" (idempotent).
  if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);

  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
  );
  if (!existing[0]) {
    throw new GraphQLError("Item not found", { extensions: { code: "NOT_FOUND" } });
  }
  const oldRow = renderRow(
    existing[0],
    collection.fields,
    ctx.dialect,
    !!collection.ownerScoped,
    collection.hasCreatedAt,
    collection.hasUpdatedAt,
  );
  if (collection.softDelete) {
    const now = ctx.dialect === "pg" ? new Date() : Date.now();
    await execute(
      ctx,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier("deleted_at")} = ${now} WHERE ${sql.join(wheres, sql` AND `)}`,
    );
  } else {
    await execute(
      ctx,
      sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)}`,
    );
  }
  await publishEvent(
    ctx.env,
    `items:${collection.slug}`,
    { event: "deleted", data: oldRow },
    { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
  );
  return true;
};

/** Shared result type for `batch<Collection>` mutations. `results` entries are
 *  JSON `{ index, op, ok, id?, data?, error? }` — heterogeneous, so a scalar. */
export const BatchResultType = new GraphQLObjectType({
  name: "BatchResult",
  fields: {
    atomic: { type: new GraphQLNonNull(GraphQLBoolean) },
    total: { type: new GraphQLNonNull(GraphQLInt) },
    succeeded: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
    results: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(JSONScalar))) },
  },
});

const normalizeBatchOps = (raw: unknown): BatchOp[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new GraphQLError("operations must be a non-empty array", {
      extensions: { code: "VALIDATION" },
    });
  }
  return raw.map((o, i) => {
    const op = (o as { op?: unknown })?.op;
    if (op !== "create" && op !== "update" && op !== "delete") {
      throw new GraphQLError(`operation #${i}: op must be create|update|delete`, {
        extensions: { code: "VALIDATION" },
      });
    }
    const e = o as { id?: unknown; data?: unknown };
    return {
      op,
      id: typeof e.id === "string" ? e.id : undefined,
      data:
        e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : undefined,
    };
  });
};

/** Result type for `bulkUpdate<Collection>` — `results` entries are JSON
 *  `{ id, ok, error? }` (heterogeneous, so a scalar). Mirrors REST
 *  `…/bulk-update`. */
export const BulkUpdateResultType = new GraphQLObjectType({
  name: "BulkUpdateResult",
  fields: {
    total: { type: new GraphQLNonNull(GraphQLInt) },
    updated: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
    results: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(JSONScalar))) },
  },
});

export const bulkUpdateResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { keys: unknown; data: unknown },
) => {
  const { ctx, auth } = gqlCtx;
  const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === "string") : [];
  if (keys.length === 0) {
    throw new GraphQLError("keys must be a non-empty array of ids", {
      extensions: { code: "VALIDATION" },
    });
  }
  const data = args.data && typeof args.data === "object" ? (args.data as Record<string, unknown>) : {};
  const full = await loadCollection(ctx, auth.tenantId, collection.slug);
  const perm = await resolvePermission(ctx, auth, collection.slug, "update");
  if (!perm.allowed) {
    throw new GraphQLError(`No update permission on ${collection.slug}`, {
      extensions: { code: "FORBIDDEN" },
    });
  }
  try {
    return await runBulkUpdate({
      ctx,
      auth,
      collection: full,
      keys,
      data,
      perm: { whereSql: perm.whereSql, fields: perm.fields },
      meta: {},
      durationMs: () => 0,
      locale: null,
    });
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

export const batchResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { operations: unknown; atomic?: boolean },
) => {
  const { ctx, auth } = gqlCtx;
  const ops = normalizeBatchOps(args.operations);
  // The GraphQL CollectionRow is a subset; reload the full row the shared
  // batch orchestrator needs (cached, so cheap).
  const full = await loadCollection(ctx, auth.tenantId, collection.slug);
  try {
    return await runBatch({
      ctx,
      auth,
      collection: full,
      operations: ops,
      atomic: args.atomic === true,
      meta: {},
      durationMs: () => 0,
      locale: null,
    });
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

