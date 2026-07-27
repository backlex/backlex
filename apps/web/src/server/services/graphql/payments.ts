import { JSONScalar, type GqlCtx } from "./core";
import { AppError } from "@backlex/core";
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
import { requireFlowAdmin } from "./flows";
import {
  connectProvider,
  disconnectProvider,
  ensurePaymentCollections,
  listPaymentEvents,
  listProviders,
  reconcileProvider,
  rotateWebhookToken,
} from "../payments";

// ── Payments (connected providers) ──────────────────────────────────────────
// Static, admin-scoped fields merged into every schema. Every resolver calls
// the same `services/payments` functions the REST route does, so the guards
// (masking, secret merge, tenant scoping) are stated exactly once. Mirrors
// REST `/api/admin/payments` + MCP `payments.*` + SDK `client.payments.*`.
//
// Deliberately NOT here: the synced business data. `payment_customers` and
// friends are ordinary collections, so they already have a generated GraphQL
// type each — exposing a second, hand-written view of them would be a
// divergence waiting to happen.

const PaymentProviderType = new GraphQLObjectType({
  name: "PaymentProvider",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    provider: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    config: {
      type: new GraphQLNonNull(JSONScalar),
      description: "Provider config with every secret field masked.",
    },
    webhookToken: { type: new GraphQLNonNull(GraphQLString) },
    webhookPath: {
      type: new GraphQLNonNull(GraphQLString),
      description: "Origin-relative path the provider should POST deliveries to.",
    },
    syncCursor: { type: JSONScalar },
    lastEventAt: { type: JSONScalar },
    lastSyncAt: { type: JSONScalar },
    lastSyncError: { type: GraphQLString },
    createdAt: { type: JSONScalar },
  },
});

const PaymentProviderInputType = new GraphQLInputObjectType({
  name: "PaymentProviderInput",
  fields: {
    provider: { type: new GraphQLNonNull(GraphQLString) },
    config: { type: JSONScalar },
    status: { type: GraphQLString },
  },
});

const PaymentEventType = new GraphQLObjectType({
  name: "PaymentEvent",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    providerId: { type: new GraphQLNonNull(GraphQLString) },
    externalId: { type: new GraphQLNonNull(GraphQLString) },
    type: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    recordCount: { type: new GraphQLNonNull(GraphQLInt) },
    error: { type: GraphQLString },
    createdAt: { type: JSONScalar },
    processedAt: { type: JSONScalar },
  },
});

const PaymentSyncResultType = new GraphQLObjectType({
  name: "PaymentSyncResult",
  fields: {
    provider: { type: new GraphQLNonNull(GraphQLString) },
    written: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
    cursors: { type: JSONScalar },
    error: { type: GraphQLString },
  },
});

const PaymentCollectionsType = new GraphQLObjectType({
  name: "PaymentCollections",
  fields: {
    created: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    existing: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    conflicts: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
  },
});

/** Re-throw service AppErrors as GraphQLErrors with the same code, so an
 *  unknown provider reads as VALIDATION here exactly as it does over REST. */
const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/** Static payment query fields, merged into every schema. */
export const paymentQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  paymentProviders: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PaymentProviderType))),
    description: "List connected payment providers in the active workspace (admin-only).",
    resolve: (_src, _args, gqlCtx) =>
      wrap(() => listProviders(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
  paymentEvents: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PaymentEventType))),
    description: "Recent inbound webhook deliveries, newest first (admin-only).",
    args: {
      providerId: { type: GraphQLString },
      limit: { type: GraphQLInt },
    },
    resolve: (_src, args, gqlCtx) => {
      const a = args as { providerId?: string; limit?: number };
      return wrap(() =>
        listPaymentEvents(gqlCtx.ctx, requireFlowAdmin(gqlCtx), {
          providerId: a.providerId,
          limit: a.limit,
        }),
      );
    },
  },
};

/** Static payment mutation fields, merged into every schema. */
export const paymentMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  connectPaymentProvider: {
    type: new GraphQLNonNull(PaymentProviderType),
    description:
      "Connect or reconfigure a payment provider and provision the four sync " +
      "collections (admin-only).",
    args: { data: { type: new GraphQLNonNull(PaymentProviderInputType) } },
    resolve: (_src, args, gqlCtx) =>
      wrap(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const data = (args as { data: Record<string, unknown> }).data;
        const out = await connectProvider(
          gqlCtx.ctx,
          tenantId,
          {
            provider: String(data.provider ?? ""),
            config: (data.config ?? undefined) as Record<string, unknown> | undefined,
            status: data.status as "connected" | "disabled" | undefined,
          },
          gqlCtx.ctx.env.AUTH_SECRET,
        );
        await ensurePaymentCollections(gqlCtx.ctx, tenantId);
        return out;
      }),
  },
  disconnectPaymentProvider: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Disconnect a provider; synced rows are kept (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_src, args, gqlCtx) =>
      wrap(async () => {
        await disconnectProvider(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id);
        return true;
      }),
  },
  rotatePaymentWebhookToken: {
    type: new GraphQLNonNull(PaymentProviderType),
    description: "Issue a fresh receive URL, invalidating the previous one (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_src, args, gqlCtx) =>
      wrap(() =>
        rotateWebhookToken(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
  syncPaymentProvider: {
    type: new GraphQLNonNull(PaymentSyncResultType),
    description:
      "Pull customers / subscriptions / invoices / payments back from the " +
      "provider API and upsert them (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      kinds: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      maxPages: { type: GraphQLInt },
      resume: { type: GraphQLBoolean },
    },
    resolve: (_src, args, gqlCtx) => {
      const a = args as { id: string; kinds?: string[]; maxPages?: number; resume?: boolean };
      return wrap(() =>
        reconcileProvider(gqlCtx.ctx, requireFlowAdmin(gqlCtx), {
          providerId: a.id,
          kinds: a.kinds as never,
          maxPages: a.maxPages,
          resume: a.resume,
        }),
      );
    },
  },
  provisionPaymentCollections: {
    type: new GraphQLNonNull(PaymentCollectionsType),
    description: "(Re-)provision the four sync collections. Idempotent (admin-only).",
    resolve: (_src, _args, gqlCtx) =>
      wrap(() => ensurePaymentCollections(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
};
