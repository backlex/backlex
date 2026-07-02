import { JSONScalar, type GqlCtx } from "./core";
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
import { AppError } from "@backlex/core";
import {
  dispatchPush,
  dispatchSms,
  rateLimitCtxFrom,
  type DispatchResult,
} from "../messaging";

// ─────────────────────────────────────────────────────────────────────────────
// Messaging (push + SMS dispatch) — thin wrappers over services/messaging so
// this surface shares the REST route's abuse guard, validation caps, and
// admin-or-self target gate (no drift). Dispatch-only (no in-app row); a
// recipient with no registered device/number resolves to sent=0.
// ─────────────────────────────────────────────────────────────────────────────

const DispatchResultType = new GraphQLObjectType({
  name: "MessagingDispatchResult",
  fields: {
    ok: { type: new GraphQLNonNull(GraphQLBoolean) },
    sent: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

/** Surface an AppError from the shared service as a GraphQLError that keeps its
 *  code (so clients see FORBIDDEN / VALIDATION / RATE_LIMITED, matching REST). */
const runDispatch = async (
  fn: () => Promise<DispatchResult>,
): Promise<DispatchResult> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
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
      data: { type: JSONScalar },
    },
    resolve: (_src, args, gqlCtx) =>
      runDispatch(() =>
        dispatchPush(
          rateLimitCtxFrom(gqlCtx.rawRequest, gqlCtx.ctx),
          gqlCtx.ctx,
          gqlCtx.auth,
          args,
        ),
      ),
  },
  sendSms: {
    type: new GraphQLNonNull(DispatchResultType),
    description:
      "Send an SMS to a user's registered phone numbers. Admins may target any user; non-admins only themselves.",
    args: {
      userId: { type: new GraphQLNonNull(GraphQLID) },
      body: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: (_src, args, gqlCtx) =>
      runDispatch(() =>
        dispatchSms(
          rateLimitCtxFrom(gqlCtx.rawRequest, gqlCtx.ctx),
          gqlCtx.ctx,
          gqlCtx.auth,
          args,
        ),
      ),
  },
};
