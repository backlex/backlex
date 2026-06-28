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
  GraphQLSchema,
  GraphQLString,
  type GraphQLFieldConfig,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";
import { and, eq, sql, type SQL } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  compileCondition,
  type FieldDef,
  type FieldType,
} from "@backlex/db";
import {
  type Action,
  AppError,
  type AuthPlane,
  type AuthSubject,
  type Condition,
  normalizeCondition,
  SYSTEM_ROLES,
} from "@backlex/core";
import {
  resolvePermission,
  simulatePermission,
  type PermResolveCache,
} from "./permissions";
import { publishEvent } from "./events";
import { loadCollection } from "./items/collection-loader";
import { runBatch, type BatchOp } from "./items/batch";
import { runBulkUpdate } from "./items/bulk";
import { runFlowById } from "./flows";
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  revokeDashboardEmbed,
  runDashboard,
  shareDashboard,
  updateDashboard,
} from "./dashboards";
import { applyTemplate } from "./templates";
import { invalidateTenantCollections } from "./collections-cache";
import { templateSummaries } from "../templates/catalog";
import {
  createAgent as createAgentRow,
  deleteAgent as deleteAgentRow,
  getAgent as getAgentRow,
  listAgents as listAgentRows,
  updateAgent as updateAgentRow,
  createThread as createAgentThreadRow,
  getThread as getAgentThreadRow,
} from "./agents/store";
import { runAgentTurn } from "./agents/runner";
import { allTools } from "../mcp/tools";
import { makeInternalFetch } from "../mcp/internal-fetch";
import type { Hono } from "hono";
import type { Ctx } from "../context";

interface CollectionRow {
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

interface GqlCtx {
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
}

const JSONScalar = new GraphQLScalarType({
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

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

const pascal = (s: string): string =>
  s.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());

const camel = (s: string): string =>
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

const buildCollectionType = (
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
            // Resolve the related row on demand. N+1 in v1 — DataLoader
            // batching moves to v2.
            const fieldKey = camel(f.name);
            fields[fieldKey] = {
              type: f.required ? new GraphQLNonNull(target) : target,
              resolve: async (parent, _args, gqlCtx) => {
                const idValue = (parent as Record<string, unknown>)[fieldKey];
                if (!idValue || typeof idValue !== "string") return null;
                return getResolver(gqlCtx, targetCollection, idValue);
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

const buildInputType = (collection: CollectionRow): GraphQLInputObjectType => {
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
): Record<string, unknown> => {
  const out: Record<string, unknown> = { id: row.id };
  if (hasCreatedAt) out.createdAt = deserialize(row.created_at, "timestamp", dialect);
  if (hasUpdatedAt) out.updatedAt = deserialize(row.updated_at, "timestamp", dialect);
  if (ownerScoped) out.ownerId = row.owner_id ?? null;
  for (const f of fields) {
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

const listResolver = async (
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
    ),
  );
};

const getResolver = async (
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
  );
};

const createResolver = async (
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

const updateResolver = async (
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
  return refreshedRow;
};

const deleteResolver = async (
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
const BatchResultType = new GraphQLObjectType({
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
const BulkUpdateResultType = new GraphQLObjectType({
  name: "BulkUpdateResult",
  fields: {
    total: { type: new GraphQLNonNull(GraphQLInt) },
    updated: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
    results: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(JSONScalar))) },
  },
});

const bulkUpdateResolver = async (
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

const batchResolver = async (
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

// ── Flows (visual workflows) ────────────────────────────────────────────────
// Static, admin-scoped query/mutation fields. Unlike collections these don't
// vary with tenant schema, so they're merged into EVERY schema (including the
// no-collections one). Mirrors REST `/api/flows` + MCP `flows.*` + the SDK
// `client.flows.*` surface.
const flowsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;

const FlowType = new GraphQLObjectType({
  name: "Flow",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    name: { type: new GraphQLNonNull(GraphQLString) },
    trigger: { type: new GraphQLNonNull(GraphQLString) },
    operations: { type: new GraphQLNonNull(JSONScalar) },
    layout: { type: JSONScalar },
    active: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const FlowInputType = new GraphQLInputObjectType({
  name: "FlowInput",
  fields: {
    name: { type: GraphQLString },
    trigger: { type: GraphQLString },
    operations: { type: JSONScalar },
    layout: { type: JSONScalar },
    active: { type: GraphQLBoolean },
  },
});

const FlowRunResultType = new GraphQLObjectType({
  name: "FlowRunResult",
  fields: {
    ok: { type: new GraphQLNonNull(GraphQLBoolean) },
    error: { type: GraphQLString },
  },
});

/** Flows are admin-only on every other surface (REST + MCP). Mirror that gate
 *  here — non-admins get a FORBIDDEN error, not a silent empty list. Returns
 *  the active tenant id (also requiring one, like the REST route). */
const requireFlowAdmin = (gqlCtx: GqlCtx): string => {
  const { auth } = gqlCtx;
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new GraphQLError("Admin role required", { extensions: { code: "FORBIDDEN" } });
  }
  if (!auth.tenantId) {
    throw new GraphQLError("Active tenant required", { extensions: { code: "UNAUTHORIZED" } });
  }
  return auth.tenantId;
};

/** sqlite stores `active` as 0/1 — coerce to a real boolean for the schema. */
const normalizeFlowRow = (r: Record<string, unknown>) => ({
  ...r,
  active: Boolean(r.active),
});

const listFlowsResolver = async (gqlCtx: GqlCtx) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const t = flowsTable(gqlCtx.ctx.dialect);
  const rows = (await (gqlCtx.ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))) as Record<string, unknown>[];
  return rows.map(normalizeFlowRow);
};

const getFlowResolver = async (gqlCtx: GqlCtx, id: string) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const t = flowsTable(gqlCtx.ctx.dialect);
  const rows = (await (gqlCtx.ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as Record<string, unknown>[];
  return rows[0] ? normalizeFlowRow(rows[0]) : null;
};

const createFlowResolver = async (
  gqlCtx: GqlCtx,
  data: Record<string, unknown>,
) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  if (typeof data?.name !== "string" || data.name.length === 0) {
    throw new GraphQLError("name is required", { extensions: { code: "VALIDATION" } });
  }
  if (typeof data.trigger !== "string" || data.trigger.length === 0) {
    throw new GraphQLError("trigger is required", { extensions: { code: "VALIDATION" } });
  }
  if (!Array.isArray(data.operations) || data.operations.length === 0) {
    throw new GraphQLError("operations must be a non-empty array", {
      extensions: { code: "VALIDATION" },
    });
  }
  const t = flowsTable(gqlCtx.ctx.dialect);
  const id = crypto.randomUUID();
  await (gqlCtx.ctx.db as any).insert(t).values({
    id,
    tenantId,
    name: data.name,
    trigger: data.trigger,
    operations: data.operations,
    layout: data.layout ?? null,
    active: data.active ?? true,
  });
  return getFlowResolver(gqlCtx, id);
};

const updateFlowResolver = async (
  gqlCtx: GqlCtx,
  id: string,
  data: Record<string, unknown>,
) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const { ctx } = gqlCtx;
  const t = flowsTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.trigger !== undefined ? { trigger: data.trigger } : {}),
      ...(data.operations !== undefined ? { operations: data.operations } : {}),
      ...(data.layout !== undefined ? { layout: data.layout } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
    })
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
  return getFlowResolver(gqlCtx, id);
};

const deleteFlowResolver = async (gqlCtx: GqlCtx, id: string) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const t = flowsTable(gqlCtx.ctx.dialect);
  await (gqlCtx.ctx.db as any)
    .delete(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
  return true;
};

const runFlowResolver = async (
  gqlCtx: GqlCtx,
  id: string,
  input: unknown,
) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const { ctx, auth } = gqlCtx;
  // Verify the flow belongs to the active workspace before running —
  // runFlowById doesn't tenant-check on its own (mirrors the REST route).
  const t = flowsTable(ctx.dialect);
  const own = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as { id: string }[];
  if (!own[0]) {
    throw new GraphQLError("Flow not found", { extensions: { code: "NOT_FOUND" } });
  }
  const payload =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const result = await runFlowById(ctx, id, payload, auth);
  return { ok: result.ok, error: result.error ?? undefined };
};

/** Static flow query fields, merged into every schema. */
const flowQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  flows: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(FlowType))),
    description: "List visual workflows in the active workspace (admin-only).",
    resolve: (_src, _args, gqlCtx) => listFlowsResolver(gqlCtx),
  },
  flow: {
    type: FlowType,
    description: "Fetch a single flow's full definition by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_src, args, gqlCtx) => getFlowResolver(gqlCtx, (args as { id: string }).id),
  },
};

/** Static flow mutation fields, merged into every schema. */
const flowMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createFlow: {
    type: FlowType,
    description: "Create a flow scoped to the active workspace (admin-only).",
    args: { data: { type: new GraphQLNonNull(FlowInputType) } },
    resolve: (_src, args, gqlCtx) =>
      createFlowResolver(gqlCtx, (args as { data: Record<string, unknown> }).data),
  },
  updateFlow: {
    type: FlowType,
    description: "Partial update of a flow by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(FlowInputType) },
    },
    resolve: (_src, args, gqlCtx) =>
      updateFlowResolver(
        gqlCtx,
        (args as { id: string }).id,
        (args as { data: Record<string, unknown> }).data,
      ),
  },
  deleteFlow: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete a flow by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_src, args, gqlCtx) => deleteFlowResolver(gqlCtx, (args as { id: string }).id),
  },
  runFlow: {
    type: new GraphQLNonNull(FlowRunResultType),
    description:
      "Run a flow synchronously with an arbitrary `input` trigger payload (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      input: { type: JSONScalar },
    },
    resolve: (_src, args, gqlCtx) =>
      runFlowResolver(gqlCtx, (args as { id: string }).id, (args as { input?: unknown }).input),
  },
};

// ── Embedded BI dashboards ───────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/admin/dashboards` + MCP
// `dashboards.*` + SDK `client.dashboards.*`. Reuses the service layer so the
// SQL stays in one place. Like flows, dashboards don't vary with collection
// schema, so the fields merge into every schema.
const DashboardType = new GraphQLObjectType({
  name: "Dashboard",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    layout: { type: JSONScalar },
    embedEnabled: { type: new GraphQLNonNull(GraphQLBoolean) },
    embedRoleId: { type: GraphQLString },
  },
});

const DashboardInputType = new GraphQLInputObjectType({
  name: "DashboardInput",
  fields: {
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    layout: { type: JSONScalar },
  },
});

const DashboardPanelResultType = new GraphQLObjectType({
  name: "DashboardPanelResult",
  fields: {
    panelId: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    viz: { type: new GraphQLNonNull(GraphQLString) },
    kind: { type: new GraphQLNonNull(GraphQLString) },
    config: { type: JSONScalar },
    data: { type: new GraphQLNonNull(JSONScalar) },
    note: { type: GraphQLString },
    error: { type: GraphQLString },
  },
});

const DashboardShareResultType = new GraphQLObjectType({
  name: "DashboardShareResult",
  fields: {
    token: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** Dashboards are admin-only on every other surface — reuse the flow gate. */
const requireDashboardAdmin = requireFlowAdmin;

/** Coerce sqlite 0/1 → boolean and drop the token hash for the API shape. */
const normalizeDashboardRow = (r: any) => ({
  id: r.id,
  tenantId: r.tenantId,
  name: r.name,
  description: r.description ?? null,
  layout: r.layout ?? null,
  embedEnabled: Boolean(r.embedEnabled),
  embedRoleId: r.embedRoleId ?? null,
});

const dashboardQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  dashboards: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DashboardType))),
    description: "List BI dashboards in the active workspace (admin-only).",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const rows = await listDashboards(gqlCtx.ctx, tenantId);
      return rows.map((r) => normalizeDashboardRow(r));
    },
  },
  dashboard: {
    type: DashboardType,
    description: "Fetch a single dashboard by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const row = await getDashboard(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      return row ? normalizeDashboardRow(row) : null;
    },
  },
};

const dashboardMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createDashboard: {
    type: DashboardType,
    description: "Create a dashboard scoped to the active workspace (admin-only).",
    args: { data: { type: new GraphQLNonNull(DashboardInputType) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const data = (args as { data: Record<string, unknown> }).data;
      if (typeof data?.name !== "string" || data.name.length === 0)
        throw new GraphQLError("name is required", { extensions: { code: "VALIDATION" } });
      const row = await createDashboard(gqlCtx.ctx, gqlCtx.auth, tenantId, {
        name: data.name,
        description: (data.description as string | null) ?? null,
        layout: (data.layout as Record<string, unknown> | null) ?? null,
      });
      return normalizeDashboardRow(row);
    },
  },
  updateDashboard: {
    type: DashboardType,
    description: "Partial update of a dashboard by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(DashboardInputType) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const a = args as { id: string; data: Record<string, unknown> };
      await updateDashboard(gqlCtx.ctx, tenantId, a.id, a.data);
      const row = await getDashboard(gqlCtx.ctx, tenantId, a.id);
      return row ? normalizeDashboardRow(row) : null;
    },
  },
  deleteDashboard: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete a dashboard by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      await deleteDashboard(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      return true;
    },
  },
  runDashboard: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DashboardPanelResultType))),
    description: "Run every panel in a dashboard and return their results (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const id = (args as { id: string }).id;
      const dash = await getDashboard(gqlCtx.ctx, tenantId, id);
      if (!dash)
        throw new GraphQLError("Dashboard not found", { extensions: { code: "NOT_FOUND" } });
      return runDashboard(gqlCtx.ctx, gqlCtx.auth, tenantId, id);
    },
  },
  shareDashboard: {
    type: new GraphQLNonNull(DashboardShareResultType),
    description: "Enable the public embed; mints a one-time token (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      roleId: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const a = args as { id: string; roleId?: string | null };
      return shareDashboard(gqlCtx.ctx, tenantId, a.id, { roleId: a.roleId ?? null });
    },
  },
  revokeDashboardEmbed: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Disable the public embed and forget the token (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      await revokeDashboardEmbed(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      return true;
    },
  },
};

// ── AI agents ────────────────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/agents` + MCP `agents.*` +
// SDK `client.agents.*`. CRUD + a `runAgent` mutation that runs one turn (same
// altitude as flows' `runFlow`). Threads/transcripts stay REST/SDK-only.
const AgentType = new GraphQLObjectType({
  name: "Agent",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    systemPrompt: { type: GraphQLString },
    model: { type: GraphQLString },
    tools: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    maxSteps: { type: new GraphQLNonNull(GraphQLInt) },
    memory: { type: new GraphQLNonNull(GraphQLBoolean) },
    active: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const AgentInputType = new GraphQLInputObjectType({
  name: "AgentInput",
  fields: {
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    systemPrompt: { type: GraphQLString },
    model: { type: GraphQLString },
    tools: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    maxSteps: { type: GraphQLInt },
    memory: { type: GraphQLBoolean },
    active: { type: GraphQLBoolean },
  },
});

const AgentRunStepType = new GraphQLObjectType({
  name: "AgentRunStep",
  fields: {
    thought: { type: GraphQLString },
    tool: { type: new GraphQLNonNull(GraphQLString) },
    args: { type: new GraphQLNonNull(JSONScalar) },
    observation: { type: new GraphQLNonNull(GraphQLString) },
    isError: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const AgentRunResultType = new GraphQLObjectType({
  name: "AgentRunResult",
  fields: {
    answer: { type: new GraphQLNonNull(GraphQLString) },
    threadId: { type: new GraphQLNonNull(GraphQLID) },
    stoppedReason: { type: new GraphQLNonNull(GraphQLString) },
    steps: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AgentRunStepType))) },
  },
});

/** Agents are admin-only on every other surface — mirror that gate (reusing the
 *  flow gate's identical admin + active-tenant check). */
const requireAgentAdmin = requireFlowAdmin;

/** sqlite stores booleans as 0/1 — coerce for the schema. */
const normalizeAgentRow = (r: Record<string, unknown>) => ({
  ...r,
  memory: Boolean(r.memory),
  active: Boolean(r.active),
  tools: Array.isArray(r.tools) ? r.tools : [],
});

const validateAgentTools = (tools: unknown): string[] | undefined => {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) {
    throw new GraphQLError("tools must be an array of tool names", {
      extensions: { code: "VALIDATION" },
    });
  }
  const known = new Set(allTools.map((t) => t.name));
  const unknown = (tools as string[]).filter((t) => !known.has(t));
  if (unknown.length) {
    throw new GraphQLError(`unknown tool(s): ${unknown.join(", ")}`, {
      extensions: { code: "VALIDATION" },
    });
  }
  return tools as string[];
};

const agentQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  agents: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AgentType))),
    description: "List AI agents in the active workspace (admin-only).",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const rows = await listAgentRows(gqlCtx.ctx, tenantId);
      return rows.map((r) => normalizeAgentRow(r as unknown as Record<string, unknown>));
    },
  },
  agent: {
    type: AgentType,
    description: "Fetch a single agent by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const row = await getAgentRow(gqlCtx.ctx, (args as { id: string }).id, tenantId);
      return row ? normalizeAgentRow(row as unknown as Record<string, unknown>) : null;
    },
  },
};

const agentMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createAgent: {
    type: AgentType,
    description: "Create an agent scoped to the active workspace (admin-only).",
    args: { data: { type: new GraphQLNonNull(AgentInputType) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const data = (args as { data: Record<string, unknown> }).data;
      if (typeof data?.name !== "string" || data.name.length === 0) {
        throw new GraphQLError("name is required", { extensions: { code: "VALIDATION" } });
      }
      const tools = validateAgentTools(data.tools);
      const row = await createAgentRow(gqlCtx.ctx, tenantId, {
        name: data.name,
        description: (data.description as string) ?? null,
        systemPrompt: (data.systemPrompt as string) ?? null,
        model: (data.model as string) ?? null,
        ...(tools ? { tools } : {}),
        ...(data.maxSteps !== undefined ? { maxSteps: Number(data.maxSteps) } : {}),
        ...(data.memory !== undefined ? { memory: Boolean(data.memory) } : {}),
        ...(data.active !== undefined ? { active: Boolean(data.active) } : {}),
      });
      return normalizeAgentRow(row as unknown as Record<string, unknown>);
    },
  },
  updateAgent: {
    type: AgentType,
    description: "Partial update of an agent by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(AgentInputType) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const id = (args as { id: string }).id;
      const data = (args as { data: Record<string, unknown> }).data;
      const tools = validateAgentTools(data.tools);
      await updateAgentRow(gqlCtx.ctx, id, tenantId, {
        ...(data.name !== undefined ? { name: data.name as string } : {}),
        ...(data.description !== undefined ? { description: data.description as string } : {}),
        ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt as string } : {}),
        ...(data.model !== undefined ? { model: data.model as string } : {}),
        ...(tools ? { tools } : {}),
        ...(data.maxSteps !== undefined ? { maxSteps: Number(data.maxSteps) } : {}),
        ...(data.memory !== undefined ? { memory: Boolean(data.memory) } : {}),
        ...(data.active !== undefined ? { active: Boolean(data.active) } : {}),
      });
      const row = await getAgentRow(gqlCtx.ctx, id, tenantId);
      return row ? normalizeAgentRow(row as unknown as Record<string, unknown>) : null;
    },
  },
  deleteAgent: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete an agent by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      await deleteAgentRow(gqlCtx.ctx, (args as { id: string }).id, tenantId);
      return true;
    },
  },
  runAgent: {
    type: new GraphQLNonNull(AgentRunResultType),
    description:
      "Send a message to an agent and run one turn to completion. Omit " +
      "`threadId` to start a fresh thread (admin-only).",
    args: {
      agent: { type: new GraphQLNonNull(GraphQLID) },
      message: { type: new GraphQLNonNull(GraphQLString) },
      threadId: { type: GraphQLID },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const { ctx, app, rawRequest } = gqlCtx;
      if (!app || !rawRequest) {
        throw new GraphQLError("agent run is unavailable in this context", {
          extensions: { code: "UNAVAILABLE" },
        });
      }
      const a = args as { agent: string; message: string; threadId?: string };
      const agentRow = await getAgentRow(ctx, a.agent, tenantId);
      if (!agentRow) {
        throw new GraphQLError("Agent not found", { extensions: { code: "NOT_FOUND" } });
      }
      let threadId = a.threadId ?? "";
      if (threadId) {
        const t = await getAgentThreadRow(ctx, threadId, tenantId);
        if (!t) throw new GraphQLError("Thread not found", { extensions: { code: "NOT_FOUND" } });
      } else {
        const t = await createAgentThreadRow(ctx, tenantId, a.agent, {
          createdBy: gqlCtx.auth.userId,
        });
        threadId = t.id;
      }
      const fetchInternal = makeInternalFetch(app, rawRequest, ctx.env);
      const result = await runAgentTurn({
        ctx,
        agentId: a.agent,
        threadId,
        tenantId,
        message: a.message,
        fetchInternal,
        auth: { userId: gqlCtx.auth.userId },
      });
      return { ...result, threadId };
    },
  },
};

// ── Permission simulator ─────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/permissions/simulate` + MCP
// `permissions.simulate` + SDK `client.permissions.simulate`. Read-only — it
// dry-runs the resolver and returns the full allow/deny trace.
const PermissionSimRuleType = new GraphQLObjectType({
  name: "PermissionSimRule",
  fields: {
    permissionId: { type: new GraphQLNonNull(GraphQLID) },
    roleId: { type: new GraphQLNonNull(GraphQLID) },
    roleName: { type: new GraphQLNonNull(GraphQLString) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    condition: { type: JSONScalar },
    fields: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    rowMatch: { type: GraphQLBoolean },
  },
});

const PermissionSimSubjectType = new GraphQLObjectType({
  name: "PermissionSimSubject",
  fields: {
    userId: { type: GraphQLID },
    email: { type: GraphQLString },
    roles: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    tenantId: { type: GraphQLID },
    plane: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const PermissionSimRoleType = new GraphQLObjectType({
  name: "PermissionSimRole",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    admin: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const PermissionSimWhereSqlType = new GraphQLObjectType({
  name: "PermissionSimWhereSql",
  fields: {
    sql: { type: new GraphQLNonNull(GraphQLString) },
    params: { type: new GraphQLNonNull(JSONScalar) },
  },
});

const PermissionSimulationType = new GraphQLObjectType({
  name: "PermissionSimulation",
  fields: {
    subject: { type: new GraphQLNonNull(PermissionSimSubjectType) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    action: { type: new GraphQLNonNull(GraphQLString) },
    allowed: { type: new GraphQLNonNull(GraphQLBoolean) },
    isAdmin: { type: new GraphQLNonNull(GraphQLBoolean) },
    reason: { type: new GraphQLNonNull(GraphQLString) },
    roles: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PermissionSimRoleType))),
    },
    matchedRules: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PermissionSimRuleType))),
    },
    resolvedVars: { type: new GraphQLNonNull(JSONScalar) },
    whereSql: { type: PermissionSimWhereSqlType },
    fields: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    rowMatch: { type: GraphQLBoolean },
  },
});

const permissionQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  permissionSimulation: {
    type: new GraphQLNonNull(PermissionSimulationType),
    description:
      "Dry-run the permission resolver for a subject against a " +
      "(collection, action) and return the full allow/deny trace (admin-only).",
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      action: { type: new GraphQLNonNull(GraphQLString) },
      userId: { type: GraphQLID },
      email: { type: GraphQLString },
      roles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      plane: { type: GraphQLString },
      sampleRow: { type: JSONScalar },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const a = args as {
        collection: string;
        action: string;
        userId?: string | null;
        email?: string | null;
        roles?: string[] | null;
        plane?: string | null;
        sampleRow?: Record<string, unknown> | null;
      };
      return simulatePermission(gqlCtx.ctx, {
        collection: a.collection,
        action: a.action as Action,
        userId: a.userId ?? null,
        email: a.email ?? null,
        roles: a.roles ?? null,
        plane: (a.plane as AuthPlane | undefined) ?? undefined,
        sampleRow: a.sampleRow ?? null,
        tenantId,
      });
    },
  },
};

// ── Schema templates ───────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/admin/templates` + MCP
// `templates.*` + SDK `client.templates.*`. Like flows, templates don't vary
// with tenant schema, so they're merged into EVERY schema build.
const TemplateCollectionSummaryType = new GraphQLObjectType({
  name: "TemplateCollectionSummary",
  fields: {
    slug: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    fieldCount: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const TemplateSummaryType = new GraphQLObjectType({
  name: "TemplateSummary",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    category: { type: new GraphQLNonNull(GraphQLString) },
    recommended: { type: new GraphQLNonNull(GraphQLBoolean) },
    sampleRows: { type: new GraphQLNonNull(GraphQLInt) },
    collections: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(TemplateCollectionSummaryType)),
      ),
    },
  },
});

const ApplyTemplateResultType = new GraphQLObjectType({
  name: "ApplyTemplateResult",
  fields: {
    templateId: { type: new GraphQLNonNull(GraphQLString) },
    created: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    skipped: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    seeded: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

/** Templates are admin-only on every surface — mirror that gate (FORBIDDEN for
 *  non-admins, not a silent empty list). Returns the active tenant id. */
const requireTemplateAdmin = (gqlCtx: GqlCtx): string => {
  const { auth } = gqlCtx;
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new GraphQLError("Admin role required", { extensions: { code: "FORBIDDEN" } });
  }
  if (!auth.tenantId) {
    throw new GraphQLError("Active tenant required", { extensions: { code: "UNAUTHORIZED" } });
  }
  return auth.tenantId;
};

const applyTemplateResolver = async (gqlCtx: GqlCtx, templateId: string) => {
  const tenantId = requireTemplateAdmin(gqlCtx);
  const { ctx } = gqlCtx;
  try {
    const result = await applyTemplate(
      { db: ctx.db, dialect: ctx.dialect },
      tenantId,
      templateId,
    );
    // Drop the cached collection list so the freshly-seeded collections resolve
    // immediately (mirrors the REST apply route).
    invalidateTenantCollections(tenantId);
    return result;
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/** Static template query fields, merged into every schema. */
const templateQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  templates: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TemplateSummaryType))),
    description: "List the schema-template catalog for the active workspace (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      requireTemplateAdmin(gqlCtx);
      return templateSummaries();
    },
  },
};

/** Static template mutation fields, merged into every schema. */
const templateMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  applyTemplate: {
    type: new GraphQLNonNull(ApplyTemplateResultType),
    description:
      "Seed a vertical template's collections (and sample data) into the active workspace. Idempotent — existing collections are skipped (admin-only).",
    args: { templateId: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      applyTemplateResolver(gqlCtx, (args as { templateId: string }).templateId),
  },
};

const singularize = (plural: string): string =>
  plural.endsWith("s") ? plural.slice(0, -1) : `${plural}One`;

const buildSchema = (collections: CollectionRow[]): GraphQLSchema => {
  if (collections.length === 0) {
    // No collections yet — but flows don't depend on collection schema, so the
    // flow query/mutation surface is still available.
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          _empty: {
            type: GraphQLString,
            resolve: () => "No collections defined yet.",
          },
          ...flowQueryFields,
          ...dashboardQueryFields,
          ...agentQueryFields,
          ...permissionQueryFields,
          ...templateQueryFields,
        },
      }),
      mutation: new GraphQLObjectType({
        name: "Mutation",
        fields: {
          ...flowMutationFields,
          ...dashboardMutationFields,
          ...agentMutationFields,
          ...templateMutationFields,
        },
      }),
    });
  }

  const queryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
    ...flowQueryFields,
    ...dashboardQueryFields,
    ...agentQueryFields,
    ...permissionQueryFields,
    ...templateQueryFields,
  };
  const mutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
    ...flowMutationFields,
    ...dashboardMutationFields,
    ...agentMutationFields,
    ...templateMutationFields,
  };

  // Pre-build the type registry so relation fields can reference target
  // collection types via the lazy `fields` thunk; types referencing each
  // other resolve at first-query time once all entries are populated.
  const typeRegistry = new Map<string, GraphQLObjectType>();
  for (const c of collections) {
    typeRegistry.set(c.slug, buildCollectionType(c, collections, typeRegistry));
  }

  for (const c of collections) {
    const Type = typeRegistry.get(c.slug)!;
    const InputType = buildInputType(c);
    const lowerName = camel(c.slug);
    const singleName = singularize(lowerName);
    const Pascal = pascal(c.slug);

    queryFields[lowerName] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Type))),
      description: `List items in collection "${c.slug}".`,
      args: {
        filter: { type: JSONScalar },
        sort: { type: GraphQLString },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
      },
      resolve: async (_src, rawArgs, gqlCtx) =>
        listResolver(gqlCtx, c, rawArgs as Parameters<typeof listResolver>[2]),
    };

    queryFields[singleName] = {
      type: Type,
      description: `Single item from "${c.slug}" by id.`,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_src, rawArgs, gqlCtx) =>
        getResolver(gqlCtx, c, (rawArgs as { id: string }).id),
    };

    mutationFields[`create${Pascal}`] = {
      type: new GraphQLNonNull(Type),
      args: { data: { type: new GraphQLNonNull(InputType) } },
      resolve: async (_src, rawArgs, gqlCtx) =>
        createResolver(
          gqlCtx,
          c,
          rawArgs as { data: Record<string, unknown> },
        ),
    };

    mutationFields[`update${Pascal}`] = {
      type: new GraphQLNonNull(Type),
      args: {
        id: { type: new GraphQLNonNull(GraphQLID) },
        data: { type: new GraphQLNonNull(InputType) },
      },
      resolve: async (_src, rawArgs, gqlCtx) =>
        updateResolver(
          gqlCtx,
          c,
          rawArgs as { id: string; data: Record<string, unknown> },
        ),
    };

    mutationFields[`delete${Pascal}`] = {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_src, rawArgs, gqlCtx) =>
        deleteResolver(gqlCtx, c, rawArgs as { id: string }),
    };

    // Bulk/transactional writes — `operations` is a JSON array of
    // `{ op: "create"|"update"|"delete", id?, data? }`; `atomic` runs them all-
    // or-nothing (Postgres / self-host SQLite only). Mirrors REST `…/batch`.
    mutationFields[`batch${Pascal}`] = {
      type: new GraphQLNonNull(BatchResultType),
      args: {
        operations: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(JSONScalar))) },
        atomic: { type: GraphQLBoolean },
      },
      resolve: async (_src, rawArgs, gqlCtx) =>
        batchResolver(gqlCtx, c, rawArgs as { operations: unknown; atomic?: boolean }),
    };

    // Bulk-update — one shared `data` patch applied to a list of `keys` (ids).
    // Partial-success; mirrors REST `…/bulk-update`.
    mutationFields[`bulkUpdate${Pascal}`] = {
      type: new GraphQLNonNull(BulkUpdateResultType),
      args: {
        keys: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
        data: { type: new GraphQLNonNull(JSONScalar) },
      },
      resolve: async (_src, rawArgs, gqlCtx) =>
        bulkUpdateResolver(gqlCtx, c, rawArgs as { keys: unknown; data: unknown }),
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: queryFields }),
    mutation: new GraphQLObjectType({ name: "Mutation", fields: mutationFields }),
  });
};

interface CachedSchema {
  hash: string;
  schema: GraphQLSchema;
}
/** Cached per tenant — collection slugs are now per-workspace, so two
 *  workspaces with overlapping slugs cannot share a single GraphQL schema. */
const cached: Map<string, CachedSchema> = new Map();

const hashCollections = (cs: CollectionRow[]): string =>
  JSON.stringify(
    cs
      .map((c) => ({ s: c.slug, f: c.fields, os: !!c.ownerScoped }))
      .sort((a, b) => a.s.localeCompare(b.s)),
  );

export const getSchema = async (
  ctx: Ctx,
  tenantId: string,
): Promise<GraphQLSchema> => {
  const t = collectionsTable(ctx.dialect);
  const collections = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))) as Array<
    Record<string, unknown>
  >;
  const normalized: CollectionRow[] = collections.map((r) => ({
    slug: r.slug as string,
    physicalTable: (r.physicalTable ?? r.physical_table) as string,
    fields: r.fields as FieldDef[],
    ownerScoped: Boolean(r.ownerScoped ?? r.owner_scoped),
    pkColumn: ((r.pkColumn ?? r.pk_column) as string | undefined) ?? "id",
    hasCreatedAt: (r.hasCreatedAt ?? r.has_created_at) === false ? false : true,
    hasUpdatedAt: (r.hasUpdatedAt ?? r.has_updated_at) === false ? false : true,
    softDelete: Boolean(r.softDelete ?? r.soft_delete),
    singleton: Boolean(r.singleton),
    versioned: Boolean(r.versioned),
    // Default-true, matching the REST collection-loader: a row is treated as
    // tenant-scoped unless it explicitly opts out (legacy/system data).
    tenantScoped: (r.tenantScoped ?? r.tenant_scoped ?? true) ? true : false,
  }));
  const hash = hashCollections(normalized);
  const hit = cached.get(tenantId);
  if (hit?.hash === hash) return hit.schema;
  const schema = buildSchema(normalized);
  cached.set(tenantId, { hash, schema });
  return schema;
};
