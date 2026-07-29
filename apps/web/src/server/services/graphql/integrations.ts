import { AppError } from "@backlex/core";
import { INTEGRATION_CATALOG, isIntegrationKind } from "@backlex/integrations";
import {
  GraphQLError,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
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
};
