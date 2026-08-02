import { AppError } from "@backlex/core";
import { INTEGRATION_CATALOG, isIntegrationKind } from "@backlex/integrations";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import { beginOAuth } from "../integrations-oauth";
import { createSync, deleteSync, listSyncs, runSync, updateSync } from "../integration-syncs";
import {
  connectIntegration,
  disconnectIntegration,
  listIntegrationDeliveries,
  listIntegrations,
  resumeIntegration,
} from "../integrations";
import { recordActivity } from "../activity";

// ── Third-party integrations ─────────────────────────────────────────────────
// Admin-scoped surface mirroring REST `/api/admin/integrations`. Every call
// funnels through services/integrations.ts, so the tenant guards, the
// encryption-at-rest of secret config, and the circuit breaker are shared
// rather than re-implemented here — re-writing a guard per surface is exactly
// how one of them ends up missing it.

const IntegrationType = new GraphQLObjectType({
  name: "Integration",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    kind: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    events: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    /** Secret fields arrive masked — the service never returns plaintext. */
    config: { type: JSONScalar },
    lastEventAt: { type: JSONScalar },
    createdAt: { type: JSONScalar },
    consecutiveFailures: { type: GraphQLInt },
    lastFailureAt: { type: JSONScalar },
    disabledReason: { type: GraphQLString },
  },
});

const IntegrationDeliveryType = new GraphQLObjectType({
  name: "IntegrationDelivery",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    integrationId: { type: new GraphQLNonNull(GraphQLString) },
    event: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(GraphQLInt) },
    ms: { type: new GraphQLNonNull(GraphQLInt) },
    error: { type: GraphQLString },
    attempts: { type: new GraphQLNonNull(GraphQLInt) },
    deliveredAt: { type: JSONScalar },
  },
});

const IntegrationProviderType = new GraphQLObjectType({
  name: "IntegrationProvider",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    category: { type: new GraphQLNonNull(GraphQLString) },
    capabilities: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    fields: { type: JSONScalar },
    /** Connected by redirect rather than by pasting a key — see `startIntegrationOAuth`. */
    oauth: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const SyncType = new GraphQLObjectType({
  name: "IntegrationSync",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    integrationId: { type: new GraphQLNonNull(GraphQLString) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    /** Which way the rows travel: `pull` in, `push` out. */
    direction: { type: new GraphQLNonNull(GraphQLString) },
    settings: { type: JSONScalar },
    mapping: { type: JSONScalar },
    intervalMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
    /** Whether more pages are pending — never the provider's resume token. */
    resuming: { type: new GraphQLNonNull(GraphQLBoolean) },
    lastRunAt: { type: JSONScalar },
    lastRowCount: { type: new GraphQLNonNull(GraphQLInt) },
    lastError: { type: GraphQLString },
    consecutiveFailures: { type: new GraphQLNonNull(GraphQLInt) },
    disabledReason: { type: GraphQLString },
    createdAt: { type: JSONScalar },
  },
});

const SyncInputType = new GraphQLInputObjectType({
  name: "IntegrationSyncInput",
  fields: {
    integrationId: { type: GraphQLString },
    collection: { type: GraphQLString },
    /** `pull` (default) brings rows in; `push` mirrors the collection out. */
    direction: { type: GraphQLString },
    settings: { type: JSONScalar },
    mapping: { type: JSONScalar },
    intervalMinutes: { type: GraphQLInt },
    enabled: { type: GraphQLBoolean },
  },
});

const SyncRunType = new GraphQLObjectType({
  name: "IntegrationSyncRun",
  fields: {
    written: { type: new GraphQLNonNull(GraphQLInt) },
    pages: { type: new GraphQLNonNull(GraphQLInt) },
    complete: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const OAuthStartType = new GraphQLObjectType({
  name: "IntegrationOAuthStart",
  fields: {
    /** Open this in a browser. Single-use, expires in 10 minutes. */
    url: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** yoga masks non-GraphQLError throws — surface AppErrors with their code. */
const surfacing = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

const invalid = (message: string): never => {
  throw new GraphQLError(message, { extensions: { code: "VALIDATION" } });
};

export const integrationQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  integrationCatalog: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(IntegrationProviderType))),
    description: "Available integration providers and their config fields (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      requireFlowAdmin(gqlCtx);
      return INTEGRATION_CATALOG;
    },
  },
  integrations: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(IntegrationType))),
    description: "List connected integrations in the active workspace, secrets masked (admin-only).",
    resolve: (_src, _args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        return listIntegrations(gqlCtx.ctx, tenantId);
      }),
  },
  integrationSyncs: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SyncType))),
    description: "Scheduled pulls from source integrations into collections (admin-only).",
    args: { integrationId: { type: GraphQLString } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        return listSyncs(gqlCtx.ctx, tenantId, (args as { integrationId?: string }).integrationId);
      }),
  },
  integrationDeliveries: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(IntegrationDeliveryType))),
    description: "Recent delivery attempts for one integration, newest first (admin-only).",
    args: {
      integrationId: { type: new GraphQLNonNull(GraphQLString) },
      limit: { type: GraphQLInt },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { integrationId: string; limit?: number | null };
        return listIntegrationDeliveries(gqlCtx.ctx, tenantId, a.integrationId, a.limit ?? 50);
      }),
  },
};

export const integrationMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  connectIntegration: {
    type: new GraphQLNonNull(IntegrationType),
    description: "Connect (or update) an integration; secret config is encrypted at rest (admin-only).",
    args: {
      kind: { type: new GraphQLNonNull(GraphQLString) },
      config: { type: JSONScalar },
      events: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { kind: string; config?: Record<string, unknown> | null; events?: string[] | null };
        if (!isIntegrationKind(a.kind)) invalid(`Unknown integration kind: ${a.kind}`);
        const data = await connectIntegration(
          gqlCtx.ctx,
          { tenantId, kind: a.kind, config: a.config ?? {}, events: a.events ?? null },
          gqlCtx.ctx.env.AUTH_SECRET,
        );
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_integrations",
          itemId: data.id,
          payload: { kind: a.kind },
        });
        return data;
      }),
  },
  disconnectIntegration: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Disconnect an integration and drop its delivery log (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const { id } = args as { id: string };
        await disconnectIntegration(gqlCtx.ctx, tenantId, id);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "delete",
          collection: "system_integrations",
          itemId: id,
        });
        return { ok: true };
      }),
  },
  resumeIntegration: {
    type: new GraphQLNonNull(IntegrationType),
    description: "Clear the failure counter and re-enable an auto-disabled integration (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const { id } = args as { id: string };
        const data = await resumeIntegration(gqlCtx.ctx, tenantId, id);
        if (!data) throw new AppError("NOT_FOUND", "Integration not found");
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_integrations",
          itemId: id,
          payload: { resumed: true },
        });
        return data;
      }),
  },
  createIntegrationSync: {
    type: new GraphQLNonNull(SyncType),
    description:
      "Create a scheduled sync between an integration and a collection (admin-only). `direction` is `pull` " +
      "(rows in, the default) or `push` (the collection mirrored out); the provider must declare that " +
      "capability. The collection must be managed, and a pull's mapping targets must be writable fields.",
    args: { data: { type: new GraphQLNonNull(SyncInputType) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const d = (args as { data: Record<string, unknown> }).data;
        if (typeof d.integrationId !== "string" || !d.integrationId) invalid("integrationId is required");
        if (typeof d.collection !== "string" || !d.collection) invalid("collection is required");
        const created = await createSync(gqlCtx.ctx, tenantId, {
          integrationId: d.integrationId as string,
          collection: d.collection as string,
          // Left undefined when absent so the service applies its own default
          // rather than this surface inventing a second one.
          direction: d.direction as "pull" | "push" | undefined,
          settings: (d.settings ?? {}) as Record<string, unknown>,
          mapping: (d.mapping ?? {}) as Record<string, string>,
          intervalMinutes: d.intervalMinutes as number | undefined,
          enabled: d.enabled as boolean | undefined,
        });
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_integration_syncs",
          itemId: created.id,
        });
        return created;
      }),
  },
  updateIntegrationSync: {
    type: new GraphQLNonNull(SyncType),
    description: "Patch a sync (admin-only). Changing `settings` resets the resume cursor.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(SyncInputType) },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { id: string; data: Record<string, unknown> };
        return updateSync(gqlCtx.ctx, tenantId, a.id, {
          settings: a.data.settings as Record<string, unknown> | undefined,
          mapping: a.data.mapping as Record<string, string> | undefined,
          intervalMinutes: a.data.intervalMinutes as number | undefined,
          enabled: a.data.enabled as boolean | undefined,
        });
      }),
  },
  deleteIntegrationSync: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Delete a sync (admin-only). Rows already pulled stay in the collection.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        await deleteSync(gqlCtx.ctx, tenantId, (args as { id: string }).id);
        return { ok: true };
      }),
  },
  runIntegrationSync: {
    type: new GraphQLNonNull(SyncRunType),
    description:
      "Run one sync now and report what landed (admin-only). Bounded to 20 pages / 2000 rows; a longer " +
      "import resumes on the schedule.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () =>
        runSync(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
  startIntegrationOAuth: {
    type: new GraphQLNonNull(OAuthStartType),
    description:
      "Begin an OAuth connect flow and return the provider URL to open (admin-only). Save the integration's " +
      "`clientId` and `clientSecret` first. The redirect lands back in the admin UI, so the browser that opens " +
      "the link must be signed in as the same admin — a link opened elsewhere is refused.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const userId = gqlCtx.auth.userId;
        // The flow is pinned to a person, so a token-authenticated caller with
        // no user behind it has nobody to pin it to.
        if (!userId) throw new AppError("FORBIDDEN", "A signed-in admin is required to start an OAuth flow");
        return beginOAuth(gqlCtx.ctx, { tenantId, userId, integrationId: (args as { id: string }).id });
      }),
  },
};
