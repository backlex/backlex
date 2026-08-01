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
  createPaymentCheckout,
  disconnectProvider,
  ensurePaymentCollections,
  listPaymentEvents,
  listProviders,
  reconcileProvider,
  refundPayment,
  rotateWebhookToken,
  type CreateCheckoutInput,
  type RefundPaymentInput,
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
    addedFields: {
      type: new GraphQLNonNull(JSONScalar),
      description: "Columns added to an already-existing sync target, by slug.",
    },
  },
});

const PaymentCheckoutWriteBackInputType = new GraphQLInputObjectType({
  name: "PaymentCheckoutWriteBackInput",
  description:
    "Store the link on the row that is asking to be paid. Both fields must " +
    "already exist on the collection.",
  fields: {
    collection: { type: new GraphQLNonNull(GraphQLString) },
    itemId: { type: new GraphQLNonNull(GraphQLID) },
    urlField: { type: new GraphQLNonNull(GraphQLString) },
    referenceField: { type: GraphQLString },
  },
});

const PaymentCheckoutInputType = new GraphQLInputObjectType({
  name: "PaymentCheckoutInput",
  fields: {
    providerId: { type: GraphQLID },
    provider: { type: GraphQLString },
    amount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: "MINOR units (cents), matching `payment_transactions.amount`.",
    },
    currency: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    customer: {
      type: JSONScalar,
      description: "PayTR and iyzico both require `email`; the rest is optional.",
    },
    successUrl: { type: GraphQLString },
    cancelUrl: { type: GraphQLString },
    reference: { type: GraphQLString },
    customerIp: { type: GraphQLString },
    expiresInSec: { type: GraphQLInt },
    locale: { type: GraphQLString },
    writeBack: { type: PaymentCheckoutWriteBackInputType },
  },
});

const PaymentCheckoutType = new GraphQLObjectType({
  name: "PaymentCheckout",
  fields: {
    provider: { type: new GraphQLNonNull(GraphQLString) },
    providerId: { type: new GraphQLNonNull(GraphQLID) },
    url: {
      type: new GraphQLNonNull(GraphQLString),
      description: "Hosted payment page — send the customer here.",
    },
    externalId: { type: new GraphQLNonNull(GraphQLString) },
    expiresAt: { type: JSONScalar },
    reference: {
      type: new GraphQLNonNull(GraphQLString),
      description:
        "Comes back on the settlement as `payment_transactions.reference` — " +
        "this is what ties the payment to the row that asked for it.",
    },
    writtenBack: { type: JSONScalar },
  },
});

const PaymentRefundInputType = new GraphQLInputObjectType({
  name: "PaymentRefundInput",
  fields: {
    providerId: { type: GraphQLID },
    provider: { type: GraphQLString },
    paymentRowId: {
      type: GraphQLID,
      description: "The `payment_transactions` row to refund.",
    },
    externalId: { type: GraphQLString, description: "The provider's own id for the payment." },
    reference: {
      type: GraphQLString,
      description:
        "The reference an outbound checkout travelled with. Refused when it matches " +
        "more than one payment.",
    },
    amount: {
      type: GraphQLInt,
      description: "MINOR units. Omitted refunds the whole remaining balance.",
    },
    reason: { type: GraphQLString },
    description: { type: GraphQLString },
    idempotencyKey: { type: GraphQLString },
  },
});

const PaymentRefundType = new GraphQLObjectType({
  name: "PaymentRefund",
  fields: {
    provider: { type: new GraphQLNonNull(GraphQLString) },
    providerId: { type: new GraphQLNonNull(GraphQLID) },
    paymentRowId: { type: new GraphQLNonNull(GraphQLID) },
    externalId: { type: new GraphQLNonNull(GraphQLString) },
    refundId: {
      type: new GraphQLNonNull(GraphQLString),
      description: "The provider's own id for the refund. Empty when it issues none.",
    },
    amount: { type: new GraphQLNonNull(GraphQLInt), description: "MINOR units refunded." },
    currency: { type: new GraphQLNonNull(GraphQLString) },
    status: {
      type: new GraphQLNonNull(GraphQLString),
      description:
        "`pending` means the provider accepted but has not decided — Adyen resolves " +
        "this in a REFUND webhook, Paddle holds live refunds for review.",
    },
    full: { type: new GraphQLNonNull(GraphQLBoolean) },
    ledger: {
      type: JSONScalar,
      description:
        "What was written to `payment_transactions`, or null for providers that file " +
        "a refund as its own transaction (Adyen, Authorize.net).",
    },
    note: { type: GraphQLString },
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
  createPaymentCheckout: {
    type: new GraphQLNonNull(PaymentCheckoutType),
    description:
      "Open a hosted checkout and get a link to send the customer to (admin-only). " +
      "Amounts are MINOR units. Stripe, Adyen, Authorize.net, PayTR, iyzico, Klarna " +
      "and the test `dummy` provider take an ad-hoc amount; Polar, Lemon Squeezy and Paddle " +
      "need a pre-made price and are refused with an explanation. Authorize.net " +
      "charges only in its account's own currency and caps the reference at 20 " +
      "characters.",
    args: { data: { type: new GraphQLNonNull(PaymentCheckoutInputType) } },
    resolve: (_src, args, gqlCtx) =>
      wrap(() =>
        createPaymentCheckout(
          gqlCtx.ctx,
          requireFlowAdmin(gqlCtx),
          (args as { data: CreateCheckoutInput }).data,
        ),
      ),
  },
  refundPayment: {
    type: new GraphQLNonNull(PaymentRefundType),
    description:
      "Give back some or all of a payment (admin-only). Say which payment by " +
      "`paymentRowId`, `externalId` or the checkout `reference`; omit `amount` to " +
      "refund everything still refundable. The remainder is checked against " +
      "`payment_transactions` before the provider is called, so a refund can never " +
      "exceed what was charged. Paddle can only refund in full from here.",
    args: { data: { type: new GraphQLNonNull(PaymentRefundInputType) } },
    resolve: (_src, args, gqlCtx) =>
      wrap(() =>
        refundPayment(
          gqlCtx.ctx,
          requireFlowAdmin(gqlCtx),
          (args as { data: RefundPaymentInput }).data,
        ),
      ),
  },
  provisionPaymentCollections: {
    type: new GraphQLNonNull(PaymentCollectionsType),
    description: "(Re-)provision the four sync collections. Idempotent (admin-only).",
    resolve: (_src, _args, gqlCtx) =>
      wrap(() => ensurePaymentCollections(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
};
