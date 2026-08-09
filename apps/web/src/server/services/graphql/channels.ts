import { AppError, SYSTEM_ROLES } from "@backlex/core";
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
  createBroadcastRule,
  deleteBroadcastRule,
  explainChannel,
  listBroadcastRules,
  readReplay,
  resolveChannelRule,
  satisfiesAccess,
  updateBroadcastRule,
} from "../broadcast";
import { recordActivity } from "../activity";

// ── Broadcast channels ───────────────────────────────────────────────────────
// Admin mirror of REST `/api/admin/realtime-channels`, plus the two READ
// surfaces a non-admin caller uses: `channelExplain` and `channelHistory`.
//
// Everything funnels through services/broadcast.ts. In particular
// `channelHistory` resolves the rule and re-checks `subscribe` here rather
// than re-deriving a permission of its own: GraphQL hand-builds its own
// resolvers and has repeatedly been the surface that skipped a guard the REST
// path applied, so the guard lives in one function that both call.

const AccessType = new GraphQLObjectType({
  name: "ChannelAccess",
  fields: {
    access: { type: new GraphQLNonNull(GraphQLString) },
    roles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    condition: { type: JSONScalar },
  },
});

const AccessInputType = new GraphQLInputObjectType({
  name: "ChannelAccessInput",
  fields: {
    access: { type: new GraphQLNonNull(GraphQLString) },
    roles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    condition: { type: JSONScalar },
  },
});

const RuleType = new GraphQLObjectType({
  name: "BroadcastChannelRule",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    pattern: { type: new GraphQLNonNull(GraphQLString) },
    subscribe: { type: new GraphQLNonNull(AccessType) },
    publish: { type: new GraphQLNonNull(AccessType) },
    presence: { type: new GraphQLNonNull(GraphQLBoolean) },
    replay: { type: new GraphQLNonNull(GraphQLBoolean) },
    retentionHours: { type: new GraphQLNonNull(GraphQLInt) },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const RuleInputType = new GraphQLInputObjectType({
  name: "BroadcastChannelRuleInput",
  fields: {
    name: { type: GraphQLString },
    pattern: { type: GraphQLString },
    subscribe: { type: AccessInputType },
    publish: { type: AccessInputType },
    presence: { type: GraphQLBoolean },
    replay: { type: GraphQLBoolean },
    retentionHours: { type: GraphQLInt },
    enabled: { type: GraphQLBoolean },
  },
});

const MatchedType = new GraphQLObjectType({
  name: "ChannelRuleMatch",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    pattern: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ExplainType = new GraphQLObjectType({
  name: "ChannelExplain",
  fields: {
    channel: { type: new GraphQLNonNull(GraphQLString) },
    managed: { type: new GraphQLNonNull(GraphQLBoolean) },
    matched: { type: MatchedType },
    params: { type: new GraphQLNonNull(JSONScalar) },
    canSubscribe: { type: new GraphQLNonNull(GraphQLBoolean) },
    canPublish: { type: new GraphQLNonNull(GraphQLBoolean) },
    reason: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const MessageType = new GraphQLObjectType({
  name: "BroadcastMessage",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    event: { type: new GraphQLNonNull(GraphQLString) },
    data: { type: JSONScalar },
    from: { type: JSONScalar },
    at: { type: new GraphQLNonNull(JSONScalar) },
    cursor: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const HistoryType = new GraphQLObjectType({
  name: "BroadcastHistory",
  fields: {
    data: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MessageType))) },
    cursor: { type: GraphQLString },
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

const requireTenant = (gqlCtx: GqlCtx): string => {
  // Signed in, always — `channelExplain` names the matching rule, so an
  // anonymous caller could otherwise map a workspace's channel topology by
  // probing names.
  if (!gqlCtx.auth.userId) {
    throw new GraphQLError("Sign in required", { extensions: { code: "UNAUTHORIZED" } });
  }
  const tenantId = gqlCtx.auth.tenantId;
  if (!tenantId) {
    throw new GraphQLError("Active workspace required", {
      extensions: { code: "UNAUTHORIZED" },
    });
  }
  return tenantId;
};

export const channelQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  broadcastChannels: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RuleType))),
    description: "List this workspace's broadcast channel rules (admin-only).",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(async () => listBroadcastRules(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
  channelExplain: {
    type: new GraphQLNonNull(ExplainType),
    description:
      "Which rule governs a channel, and whether THIS caller may subscribe or publish. " +
      "Answers for the calling identity, so it is safe for a non-admin to ask about its own access.",
    args: { channel: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () =>
        explainChannel(
          gqlCtx.ctx,
          requireTenant(gqlCtx),
          gqlCtx.auth,
          (args as { channel: string }).channel,
          gqlCtx.auth.roles.includes(SYSTEM_ROLES.admin),
        ),
      ),
  },
  channelHistory: {
    type: new GraphQLNonNull(HistoryType),
    description:
      "Retained messages for an application-owned channel, oldest first. Requires the same " +
      "subscribe access a live subscription does.",
    args: {
      channel: { type: new GraphQLNonNull(GraphQLString) },
      since: { type: GraphQLString },
      limit: { type: GraphQLInt },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as { channel: string; since?: string; limit?: number };
        const tenantId = requireTenant(gqlCtx);
        const resolved = await resolveChannelRule(gqlCtx.ctx, tenantId, a.channel);
        if (!resolved) {
          throw new AppError("FORBIDDEN", `No channel rule matches "${a.channel}"`);
        }
        if (!satisfiesAccess(resolved.rule.subscribe, gqlCtx.auth, resolved.params)) {
          throw new AppError(
            gqlCtx.auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
            `The rule "${resolved.rule.name}" does not let you subscribe to "${a.channel}"`,
          );
        }
        return readReplay(
          gqlCtx.ctx,
          tenantId,
          a.channel,
          resolved.rule,
          a.since,
          a.limit ?? 25,
        );
      }),
  },
};

export const channelMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createBroadcastChannel: {
    type: new GraphQLNonNull(RuleType),
    description:
      "Create a broadcast channel rule (admin-only). Channels with no matching rule are refused " +
      "in both directions, so this is how an application-owned channel comes into existence.",
    args: { data: { type: new GraphQLNonNull(RuleInputType) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const created = await createBroadcastRule(
          gqlCtx.ctx,
          tenantId,
          (args as { data: Record<string, unknown> }).data as never,
        );
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_realtime_channels",
          itemId: created.id,
          payload: { pattern: created.pattern },
        });
        return created;
      }),
  },
  updateBroadcastChannel: {
    type: new GraphQLNonNull(RuleType),
    description: "Update a broadcast channel rule (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(RuleInputType) },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { id: string; data: Record<string, unknown> };
        const updated = await updateBroadcastRule(gqlCtx.ctx, tenantId, a.id, a.data as never);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_realtime_channels",
          itemId: a.id,
        });
        return updated;
      }),
  },
  deleteBroadcastChannel: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Delete a broadcast channel rule (admin-only). Channels it matched are refused from the " +
      "next request onward.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const { id } = args as { id: string };
        await deleteBroadcastRule(gqlCtx.ctx, tenantId, id);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "delete",
          collection: "system_realtime_channels",
          itemId: id,
        });
        return { ok: true };
      }),
  },
};
