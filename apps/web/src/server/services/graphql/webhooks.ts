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
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  retryDelivery,
  testWebhook,
  updateWebhook,
  type WebhookConfigInput,
} from "../webhooks";
import { recordActivity } from "../activity";

// ── Outbound webhooks ────────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/webhooks`. CRUD funnels
// through services/webhooks.ts helpers (breaker-reset rule lives there);
// deliveries/test/retry reuse the same delivery engine. Activity rows are
// written via recordActivity (REST logs ip/UA through logActivity instead).

const WebhookType = new GraphQLObjectType({
  name: "Webhook",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    name: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
    events: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    headers: { type: JSONScalar },
    secret: { type: GraphQLString },
    active: { type: new GraphQLNonNull(GraphQLBoolean) },
    consecutiveFailures: { type: GraphQLInt },
    lastFailureAt: { type: JSONScalar },
    disabledReason: { type: GraphQLString },
  },
});

const WebhookInputType = new GraphQLInputObjectType({
  name: "WebhookInput",
  fields: {
    name: { type: GraphQLString },
    url: { type: GraphQLString },
    events: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    headers: { type: JSONScalar },
    secret: { type: GraphQLString },
    active: { type: GraphQLBoolean },
  },
});

const WebhookDeliveryType = new GraphQLObjectType({
  name: "WebhookDelivery",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    webhookId: { type: new GraphQLNonNull(GraphQLString) },
    event: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: GraphQLInt },
    error: { type: GraphQLString },
    payload: { type: JSONScalar },
    response: { type: JSONScalar },
    createdAt: { type: JSONScalar },
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

/** Mirror the REST zod contract (`WebhookInput`) for create/update payloads. */
const validateWebhookInput = (
  data: Record<string, unknown>,
  { partial }: { partial: boolean },
): Partial<WebhookConfigInput> => {
  const out: Partial<WebhookConfigInput> = {};
  if (data.name !== undefined && data.name !== null) {
    if (typeof data.name !== "string" || data.name.length === 0)
      invalid("name must be a non-empty string");
    out.name = data.name as string;
  } else if (!partial) invalid("name is required");
  if (data.url !== undefined && data.url !== null) {
    try {
      new URL(data.url as string);
    } catch {
      invalid("url must be a valid URL");
    }
    out.url = data.url as string;
  } else if (!partial) invalid("url is required");
  if (data.events !== undefined && data.events !== null) {
    const events = data.events as unknown[];
    if (!Array.isArray(events) || events.length === 0)
      invalid("events must be a non-empty list of patterns");
    if (events.some((e) => typeof e !== "string" || e.length === 0))
      invalid("events entries must be non-empty strings");
    out.events = events as string[];
  } else if (!partial) invalid("events is required");
  if (data.headers !== undefined)
    out.headers = data.headers as Record<string, string> | null;
  if (data.secret !== undefined && data.secret !== null) out.secret = data.secret as string;
  if (data.active !== undefined && data.active !== null) out.active = data.active as boolean;
  return out;
};

/** sqlite stores `active` as 0/1 — coerce for the non-null Boolean field. */
const normalizeWebhookRow = (r: Record<string, unknown>) => ({
  ...r,
  active: Boolean(r.active),
});

export const webhookQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  webhooks: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WebhookType))),
    description: "List outbound webhooks in the active workspace (admin-only).",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const rows = await listWebhooks(gqlCtx.ctx, tenantId);
      return rows.map(normalizeWebhookRow);
    },
  },
  webhookDeliveries: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WebhookDeliveryType))),
    description: "Recent webhook deliveries, newest first (admin-only).",
    args: {
      webhookId: { type: GraphQLString },
      limit: { type: GraphQLInt },
    },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { webhookId?: string | null; limit?: number | null };
      const limit = Math.max(1, Math.min(500, a.limit ?? 50));
      return listDeliveries(gqlCtx.ctx, {
        webhookId: a.webhookId ?? undefined,
        limit,
        tenantId,
      });
    },
  },
};

export const webhookMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createWebhook: {
    type: new GraphQLNonNull(WebhookType),
    description: "Create an outbound webhook (admin-only).",
    args: { data: { type: new GraphQLNonNull(WebhookInputType) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const input = validateWebhookInput(
        (args as { data: Record<string, unknown> }).data,
        { partial: false },
      ) as WebhookConfigInput;
      const created = await createWebhook(gqlCtx.ctx, tenantId, input);
      await recordActivity(gqlCtx.ctx, {
        userId: gqlCtx.auth.userId ?? null,
        tenantId,
        action: "create",
        collection: "system_webhooks",
        itemId: created.id as string,
        payload: { name: input.name, url: input.url },
        response: { data: created },
      });
      return normalizeWebhookRow(created);
    },
  },
  updateWebhook: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Partial update of a webhook by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(WebhookInputType) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { id: string; data: Record<string, unknown> };
      const patch = validateWebhookInput(a.data, { partial: true });
      await updateWebhook(gqlCtx.ctx, tenantId, a.id, patch);
      await recordActivity(gqlCtx.ctx, {
        userId: gqlCtx.auth.userId ?? null,
        tenantId,
        action: "update",
        collection: "system_webhooks",
        itemId: a.id,
        payload: patch,
        response: { ok: true },
      });
      return true;
    },
  },
  deleteWebhook: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete a webhook by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const id = (args as { id: string }).id;
      await deleteWebhook(gqlCtx.ctx, tenantId, id);
      await recordActivity(gqlCtx.ctx, {
        userId: gqlCtx.auth.userId ?? null,
        tenantId,
        action: "delete",
        collection: "system_webhooks",
        itemId: id,
        response: { ok: true },
      });
      return true;
    },
  },
  testWebhook: {
    type: JSONScalar,
    description:
      "Fire a synthetic `webhook.test` delivery at the hook (admin-only). " +
      "Returns the delivery outcome `{ status, error? }`.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const id = (args as { id: string }).id;
      const r = await surfacing(() => testWebhook(gqlCtx.ctx, tenantId, id));
      await recordActivity(gqlCtx.ctx, {
        userId: gqlCtx.auth.userId ?? null,
        tenantId,
        action: "test",
        collection: "system_webhooks",
        itemId: id,
        payload: { status: r?.status, error: r?.error },
        response: { data: r },
      });
      return r;
    },
  },
  retryWebhookDelivery: {
    type: JSONScalar,
    description:
      "Replay a past delivery with the original headers + signature (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const out = await retryDelivery(gqlCtx.ctx, (args as { id: string }).id, tenantId);
      if (!out)
        throw new GraphQLError("Delivery (or its hook) is gone", {
          extensions: { code: "NOT_FOUND" },
        });
      return out;
    },
  },
};
