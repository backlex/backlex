import {
  BatchResultType,
  BulkUpdateResultType,
  batchResolver,
  buildCollectionType,
  buildInputType,
  bulkUpdateResolver,
  aggregateResolver,
  changesResolver,
  camel,
  collectionsTable,
  createResolver,
  deleteResolver,
  getResolver,
  listResolver,
  pascal,
  searchResolver,
  updateResolver,
  verifyResolver,
  JSONScalar,
  type CollectionRow,
  type GqlCtx,
} from "./core";
import { flowQueryFields, flowMutationFields } from "./flows";
import { paymentQueryFields, paymentMutationFields } from "./payments";
import { extensionQueryFields, extensionMutationFields } from "./extensions";
import { messagingMutationFields } from "./messaging";
import { dashboardQueryFields, dashboardMutationFields } from "./dashboards";
import { analyticsQueryFields, analyticsMutationFields } from "./analytics";
import { formQueryFields, formMutationFields } from "./forms";
import { usageQueryFields, usageMutationFields } from "./usage";
import { advisorQueryFields, advisorMutationFields } from "./advisor";
import { backupQueryFields, backupMutationFields } from "./backups";
import { webhookQueryFields, webhookMutationFields } from "./webhooks";
import { integrationQueryFields, integrationMutationFields } from "./integrations";
import { syncHookQueryFields, syncHookMutationFields } from "./sync-hooks";
import { documentQueryFields, documentMutationFields } from "./documents";
import { signatureQueryFields, signatureMutationFields } from "./signatures";
import { i18nQueryFields, i18nMutationFields } from "./i18n";
import { storageQueryFields, storageMutationFields } from "./storage";
import { schemaVersionQueryFields, schemaVersionMutationFields } from "./schema-versions";
import { migrateQueryFields, migrateMutationFields } from "./migrate";
import { agentQueryFields, agentMutationFields } from "./agents";
import { permissionQueryFields } from "./permission-sim";
import { templateQueryFields, templateMutationFields } from "./templates";
import { appUserMutationFields } from "./app-users";
import { appOrgMutationFields, appOrgQueryFields } from "./app-orgs";
import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { eq, } from "drizzle-orm";
import {
  type FieldDef,
  isKnownFieldType,
} from "@backlex/db";
import { log } from "../../lib/log";
import type { Ctx } from "../../context";

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
          ...paymentQueryFields,
          ...extensionQueryFields,
          ...dashboardQueryFields,
          ...analyticsQueryFields,
          ...formQueryFields,
          ...usageQueryFields,
          ...advisorQueryFields,
          ...backupQueryFields,
          ...webhookQueryFields,
          ...integrationQueryFields,
          ...syncHookQueryFields,
          ...documentQueryFields,
          ...signatureQueryFields,
          ...i18nQueryFields,
          ...storageQueryFields,
          ...schemaVersionQueryFields,
          ...migrateQueryFields,
          ...agentQueryFields,
          ...permissionQueryFields,
          ...templateQueryFields,
          ...appOrgQueryFields,
        },
      }),
      mutation: new GraphQLObjectType({
        name: "Mutation",
        fields: {
          ...flowMutationFields,
          ...paymentMutationFields,
          ...extensionMutationFields,
          ...dashboardMutationFields,
          ...analyticsMutationFields,
          ...formMutationFields,
          ...usageMutationFields,
          ...advisorMutationFields,
          ...backupMutationFields,
          ...webhookMutationFields,
          ...integrationMutationFields,
          ...syncHookMutationFields,
          ...documentMutationFields,
          ...signatureMutationFields,
          ...i18nMutationFields,
          ...storageMutationFields,
          ...schemaVersionMutationFields,
          ...migrateMutationFields,
          ...agentMutationFields,
          ...templateMutationFields,
          ...appUserMutationFields,
          ...appOrgMutationFields,
          ...messagingMutationFields,
        },
      }),
    });
  }

  const queryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
    ...flowQueryFields,
    ...paymentQueryFields,
    ...extensionQueryFields,
    ...dashboardQueryFields,
    ...analyticsQueryFields,
    ...formQueryFields,
    ...usageQueryFields,
    ...advisorQueryFields,
    ...backupQueryFields,
    ...webhookQueryFields,
    ...integrationQueryFields,
    ...syncHookQueryFields,
    ...documentQueryFields,
    ...signatureQueryFields,
    ...i18nQueryFields,
    ...storageQueryFields,
    ...schemaVersionQueryFields,
    ...migrateQueryFields,
    ...agentQueryFields,
    ...permissionQueryFields,
    ...templateQueryFields,
    ...appOrgQueryFields,
  };
  const mutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
    ...flowMutationFields,
    ...paymentMutationFields,
    ...extensionMutationFields,
    ...dashboardMutationFields,
    ...analyticsMutationFields,
    ...formMutationFields,
    ...usageMutationFields,
    ...advisorMutationFields,
    ...backupMutationFields,
    ...webhookMutationFields,
    ...integrationMutationFields,
    ...syncHookMutationFields,
    ...documentMutationFields,
    ...signatureMutationFields,
    ...i18nMutationFields,
    ...storageMutationFields,
    ...schemaVersionMutationFields,
    ...migrateMutationFields,
    ...agentMutationFields,
    ...templateMutationFields,
    ...appUserMutationFields,
    ...appOrgMutationFields,
    ...messagingMutationFields,
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

    queryFields[`${lowerName}Aggregate`] = {
      type: new GraphQLNonNull(JSONScalar),
      description:
        `Aggregate "${c.slug}": count / sum / avg / min / max, optionally ` +
        "grouped by a column. Returns `[{ value }]` (scalar) or " +
        "`[{ label, value }, …]` (grouped, value desc). Mirrors REST " +
        "`POST /api/items/{slug}/aggregate` — same permission/tenant/draft guards.",
      args: {
        agg: { type: new GraphQLNonNull(GraphQLString) },
        field: { type: GraphQLString },
        groupBy: { type: GraphQLString },
        filter: { type: JSONScalar },
        limit: { type: GraphQLInt },
      },
      resolve: async (_src, rawArgs, gqlCtx) =>
        aggregateResolver(gqlCtx, c, rawArgs as Parameters<typeof aggregateResolver>[2]),
    };

    queryFields[`${lowerName}Search`] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Type))),
      description:
        `Relevance search over "${c.slug}": full-text (\`fts\`), semantic ` +
        "(`vector`), or `hybrid` (RRF fusion), best-first. Mirrors REST " +
        "`POST /api/items/{slug}/search` — permission, tenant, soft-delete and " +
        "draft visibility all enforced at hydration.",
      args: {
        q: { type: new GraphQLNonNull(GraphQLString) },
        mode: { type: GraphQLString },
        limit: { type: GraphQLInt },
        locale: { type: GraphQLString },
      },
      resolve: async (_src, rawArgs, gqlCtx) =>
        searchResolver(gqlCtx, c, rawArgs as Parameters<typeof searchResolver>[2]),
    };

    queryFields[`${lowerName}Changes`] = {
      type: new GraphQLNonNull(JSONScalar),
      description:
        `Incremental changefeed for "${c.slug}" — rows changed past the ` +
        "`since` cursor, keyset-paginated on (updatedAt, id), including " +
        "soft-delete tombstones (`_deleted`). Pass `shape` (a flat filter) to " +
        "replicate a subset: rows that LEFT the shape come back as " +
        "`{ id, _shape_exit: true }` so an offline store can drop them. " +
        "Returns `{ data, cursor, hasMore, shape? }`. Mirrors REST " +
        "`GET /api/items/{slug}/changes` — same permission, tenant and draft guards.",
      args: {
        since: { type: GraphQLString },
        limit: { type: GraphQLInt },
        shape: { type: JSONScalar },
        fields: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      },
      resolve: async (_src, rawArgs, gqlCtx) =>
        changesResolver(gqlCtx, c, rawArgs as Parameters<typeof changesResolver>[2]),
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

    // `verify<Collection>` — only emitted when the collection has a `hash`
    // field. Checks a plaintext against the stored digest without returning it.
    // Mirrors REST `POST /:slug/:id/verify` and reuses the same shared service.
    if (c.fields.some((f) => f.type === "hash")) {
      mutationFields[`verify${Pascal}`] = {
        type: new GraphQLNonNull(GraphQLBoolean),
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          field: { type: new GraphQLNonNull(GraphQLString) },
          value: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: async (_src, rawArgs, gqlCtx) =>
          verifyResolver(gqlCtx, c, rawArgs as { id: string; field: string; value: string }),
      };
    }
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
    id: r.id as string,
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
    stagedEdits: Boolean(r.stagedEdits ?? r.staged_edits),
    // Default-true, matching the REST collection-loader: a row is treated as
    // tenant-scoped unless it explicitly opts out (legacy/system data).
    tenantScoped: (r.tenantScoped ?? r.tenant_scoped ?? true) ? true : false,
  }));
  const hash = hashCollections(normalized);
  const hit = cached.get(tenantId);
  if (hit?.hash === hash) return hit.schema;
  warnOnUnknownFieldTypes(normalized, tenantId);
  const schema = buildSchema(normalized);
  cached.set(tenantId, { hash, schema });
  return schema;
};

/**
 * A field type this build doesn't recognise no longer breaks the schema — it
 * degrades to opaque JSON (see `fieldGqlType`). But degrading silently means an
 * operator never learns their metadata has rotted, so say so once per schema
 * build. The schema is cached per tenant and keyed on the collections' contents,
 * so this fires when the schema actually (re)builds, not per request.
 */
const warnOnUnknownFieldTypes = (collections: CollectionRow[], tenantId: string): void => {
  const bad: string[] = [];
  for (const c of collections) {
    for (const f of c.fields ?? []) {
      if (!isKnownFieldType(f.type)) bad.push(`${c.slug}.${f.name} (${String(f.type)})`);
    }
  }
  if (bad.length === 0) return;
  log.warn("graphql.unknown_field_type", {
    tenantId,
    fields: bad,
    hint: "Written by an older build. Exposed as JSON; edit the collection to set a current type.",
  });
};
