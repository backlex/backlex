import { type GqlCtx } from "./core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import {
  SYSTEM_ROLES,
} from "@backlex/core";
import { sendPushToUsers } from "../push";
import { sendSmsToUsers } from "../sms";

// ─────────────────────────────────────────────────────────────────────────────
// Messaging (push + SMS dispatch) — mirrors POST /api/messaging/{push,sms}:
// dispatch-only (no in-app notification row), admins may target any user,
// non-admins only themselves. A recipient with no registered device/number
// resolves to sent=0 rather than erroring.
// ─────────────────────────────────────────────────────────────────────────────

const DispatchResultType = new GraphQLObjectType({
  name: "MessagingDispatchResult",
  fields: {
    ok: { type: new GraphQLNonNull(GraphQLBoolean) },
    sent: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const requireMessagingTarget = (gqlCtx: GqlCtx, targetUserId: string): string => {
  const { auth } = gqlCtx;
  if (!auth.tenantId) {
    throw new GraphQLError("Active tenant required", { extensions: { code: "UNAUTHORIZED" } });
  }
  if (!auth.roles.includes(SYSTEM_ROLES.admin) && targetUserId !== auth.userId) {
    throw new GraphQLError("Non-admins can only message themselves", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return auth.tenantId;
};

export const messagingMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  sendPush: {
    type: new GraphQLNonNull(DispatchResultType),
    description:
      "Send a push notification to a user's registered devices (dispatch-only — no in-app notification row). Admins may target any user; non-admins only themselves.",
    args: {
      userId: { type: new GraphQLNonNull(GraphQLID) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      body: { type: new GraphQLNonNull(GraphQLString) },
      url: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const a = args as { userId: string; title: string; body: string; url?: string };
      if (!a.title || !a.body) {
        throw new GraphQLError("title and body are required", {
          extensions: { code: "VALIDATION" },
        });
      }
      const tenantId = requireMessagingTarget(gqlCtx, a.userId);
      const r = await sendPushToUsers(gqlCtx.ctx, tenantId, {
        userIds: [a.userId],
        title: a.title,
        body: a.body,
        url: a.url,
      });
      return { ok: true, sent: r.sent, failed: r.failed };
    },
  },
  sendSms: {
    type: new GraphQLNonNull(DispatchResultType),
    description:
      "Send an SMS to a user's registered phone numbers. Admins may target any user; non-admins only themselves.",
    args: {
      userId: { type: new GraphQLNonNull(GraphQLID) },
      body: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const a = args as { userId: string; body: string };
      if (!a.body || a.body.length > 1600) {
        throw new GraphQLError("body is required (max 1600 chars)", {
          extensions: { code: "VALIDATION" },
        });
      }
      const tenantId = requireMessagingTarget(gqlCtx, a.userId);
      const r = await sendSmsToUsers(gqlCtx.ctx, tenantId, {
        userIds: [a.userId],
        body: a.body,
      });
      return { ok: true, sent: r.sent, failed: r.failed };
    },
  },
};

