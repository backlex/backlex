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
import { eq, sql, type SQL } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  compileCondition,
  type FieldDef,
  type FieldType,
} from "@backlex/db";
import { type AuthSubject, type Condition, normalizeCondition } from "@backlex/core";
import { resolvePermission, type PermResolveCache } from "./permissions";
import { publishEvent } from "./events";
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
}

interface GqlCtx {
  ctx: Ctx;
  auth: AuthSubject;
  /** Per-request L1 permission cache, threaded through every resolver so a
   *  single GraphQL query doesn't re-resolve the same (collection, action)
   *  pair across `list`/`get`/sub-selections. Populated by the GraphQL
   *  route via `getRequestPermCache(c)`. */
  permCache?: PermResolveCache;
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
  const parts = sortStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const dir: "ASC" | "DESC" = s.startsWith("-") ? "DESC" : "ASC";
      const field = s.replace(/^[-+]/, "");
      return sql`${sql.identifier(field)} ${sql.raw(dir)}`;
    });
  return parts.length === 0 ? fallback : sql`ORDER BY ${sql.join(parts, sql`, `)}`;
};

const denyOrThrow = (auth: AuthSubject, slug: string) => {
  throw new GraphQLError(
    auth.userId
      ? `No read permission for ${slug}`
      : "Sign in required",
    { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
  );
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
  const wheres = [userWhere, perm.whereSql, deletedWhere].filter(
    (x): x is SQL => x != null,
  );
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
  if (perm.whereSql) wheres.push(perm.whereSql);
  if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
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

  // Singleton: reject when a live row already exists (scoped by the caller's
  // read permission, ignoring soft-deleted rows). GraphQL has no tenant
  // filter of its own, so isolation rides on `perm.whereSql`.
  if (collection.singleton) {
    const guardWheres = [
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

const singularize = (plural: string): string =>
  plural.endsWith("s") ? plural.slice(0, -1) : `${plural}One`;

const buildSchema = (collections: CollectionRow[]): GraphQLSchema => {
  if (collections.length === 0) {
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          _empty: {
            type: GraphQLString,
            resolve: () => "No collections defined yet.",
          },
        },
      }),
    });
  }

  const queryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {};
  const mutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {};

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
  }));
  const hash = hashCollections(normalized);
  const hit = cached.get(tenantId);
  if (hit?.hash === hash) return hit.schema;
  const schema = buildSchema(normalized);
  cached.set(tenantId, { hash, schema });
  return schema;
};
