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
  cancelRequest,
  createApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
} from "../approvals";
import { recordActivity } from "../activity";

// ── Approvals ────────────────────────────────────────────────────────────────
// Admin-scoped mirror of REST `/api/admin/approvals`. Everything funnels
// through services/approvals.ts, so the one-shot settle guard, the write-back
// and the flow resumption are shared rather than restated — restating a guard
// per surface is how one of them ends up missing.
//
// There is deliberately no `decide` here. Deciding is the APPROVER's act,
// authenticated by a link token and nothing else; exposing it on an
// admin-authenticated API would be an admin approving on somebody's behalf.

const ApproverType = new GraphQLObjectType({
  name: "Approver",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: GraphQLString },
    role: { type: GraphQLString },
    order: { type: new GraphQLNonNull(GraphQLInt) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    sentAt: { type: JSONScalar },
    viewedAt: { type: JSONScalar },
    decidedAt: { type: JSONScalar },
    reason: { type: GraphQLString },
    ip: { type: GraphQLString },
    userAgent: { type: GraphQLString },
  },
});

const RequestType = new GraphQLObjectType({
  name: "ApprovalRequest",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    message: { type: GraphQLString },
    subject: { type: JSONScalar },
    summary: { type: JSONScalar },
    policy: { type: new GraphQLNonNull(GraphQLString) },
    quorum: { type: new GraphQLNonNull(GraphQLInt) },
    ordered: { type: new GraphQLNonNull(GraphQLBoolean) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    expiresAt: { type: JSONScalar },
    settledAt: { type: JSONScalar },
    outcomeReason: { type: GraphQLString },
    writeBack: { type: JSONScalar },
    createdBy: { type: GraphQLString },
    createdAt: { type: JSONScalar },
    updatedAt: { type: JSONScalar },
    approvers: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ApproverType))) },
  },
});

const ApproverInputType = new GraphQLInputObjectType({
  name: "ApproverInput",
  fields: {
    email: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: GraphQLString },
    role: { type: GraphQLString },
  },
});

const LinkType = new GraphQLObjectType({
  name: "ApprovalLink",
  fields: {
    approverId: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const CreatedType = new GraphQLObjectType({
  name: "CreatedApprovalRequest",
  fields: {
    request: { type: new GraphQLNonNull(RequestType) },
    /** Returned exactly once — only the hashes are stored. */
    links: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(LinkType))) },
    sent: { type: new GraphQLNonNull(GraphQLBoolean) },
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

export const approvalQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  approvalRequests: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RequestType))),
    description:
      "List approval requests in the active workspace (admin-only). Pending requests sort first, then by how soon they expire.",
    args: {
      status: { type: GraphQLString },
      limit: { type: GraphQLInt },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as { status?: string; limit?: number };
        return listApprovalRequests(gqlCtx.ctx, requireFlowAdmin(gqlCtx), {
          ...(a.status ? { status: a.status } : {}),
          ...(a.limit != null ? { limit: a.limit } : {}),
        });
      }),
  },
  approvalRequest: {
    type: new GraphQLNonNull(RequestType),
    description:
      "One approval request with the full decision trail — who was asked, who answered, when, from where and why (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () =>
        getApprovalRequest(gqlCtx.ctx, (args as { id: string }).id, requireFlowAdmin(gqlCtx)),
      ),
  },
};

export const approvalMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createApprovalRequest: {
    type: new GraphQLNonNull(CreatedType),
    description:
      "Ask people to approve something (admin-only). The plaintext decision links are returned on this response and nowhere else — only their hashes are stored.",
    args: {
      title: { type: new GraphQLNonNull(GraphQLString) },
      message: { type: GraphQLString },
      approvers: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ApproverInputType))) },
      policy: { type: GraphQLString },
      quorum: { type: GraphQLInt },
      ordered: { type: GraphQLBoolean },
      expiresInHours: { type: GraphQLInt },
      subject: { type: JSONScalar },
      summary: { type: JSONScalar },
      writeBack: { type: JSONScalar },
      notifyEmails: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      send: { type: GraphQLBoolean },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const created = await createApprovalRequest(
          gqlCtx.ctx,
          tenantId,
          args as never,
          gqlCtx.auth.userId ?? null,
        );
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_approval_requests",
          itemId: created.request.id,
          // The count, never the links — an activity row is read by more
          // people than the invitation email is.
          payload: { title: created.request.title, approvers: created.request.approvers.length },
        });
        return created;
      }),
  },
  cancelApprovalRequest: {
    type: new GraphQLNonNull(RequestType),
    description:
      "Withdraw an approval request (admin-only). Closes it and kills every outstanding link; NEITHER flow branch runs, because the operator who withdrew it asked for neither.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) }, reason: { type: GraphQLString } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { id: string; reason?: string };
        const out = await cancelRequest(gqlCtx.ctx, a.id, tenantId, a.reason ?? null);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_approval_requests",
          itemId: a.id,
          payload: { status: "cancelled" },
        });
        return out;
      }),
  },
};
