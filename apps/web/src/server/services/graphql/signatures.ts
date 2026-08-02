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
  createSignatureRequest,
  finalizePendingRequest,
  getSignatureRequest,
  listSignatureRequests,
  resendSignatureInvite,
  voidSignatureRequest,
  type SignatureStatus,
} from "../signatures";
import { recordActivity } from "../activity";

// ── E-signature ──────────────────────────────────────────────────────────────
// Admin-scoped mirror of REST `/api/admin/signatures`. Everything funnels
// through services/signatures.ts, so the snapshot rule, the token rotation on
// void/resend and the derived expiry are shared rather than restated —
// restating a guard per surface is how one of them ends up missing.
//
// There is deliberately no `signDocument` here. Signing is the SIGNER's act,
// authenticated by a link token and nothing else; exposing it on an
// admin-authenticated API would be an admin signing on somebody's behalf.

const SignerType = new GraphQLObjectType({
  name: "SignatureSigner",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: GraphQLString },
    role: { type: GraphQLString },
    order: { type: new GraphQLNonNull(GraphQLInt) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    sentAt: { type: JSONScalar },
    viewedAt: { type: JSONScalar },
    signedAt: { type: JSONScalar },
    declinedAt: { type: JSONScalar },
    declineReason: { type: GraphQLString },
    signatureKind: { type: GraphQLString },
    ip: { type: GraphQLString },
    userAgent: { type: GraphQLString },
  },
});

const RequestType = new GraphQLObjectType({
  name: "SignatureRequest",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    message: { type: GraphQLString },
    templateKey: { type: GraphQLString },
    /** `expired` is derived from the expiry timestamp, never stored. */
    status: { type: new GraphQLNonNull(GraphQLString) },
    ordered: { type: new GraphQLNonNull(GraphQLBoolean) },
    documentHash: { type: new GraphQLNonNull(GraphQLString) },
    documentKey: { type: GraphQLString },
    signedDocumentKey: { type: GraphQLString },
    signedDocumentHash: { type: GraphQLString },
    filename: { type: GraphQLString },
    expiresAt: { type: JSONScalar },
    completedAt: { type: JSONScalar },
    voidedAt: { type: JSONScalar },
    voidReason: { type: GraphQLString },
    writeBack: { type: JSONScalar },
    notifyEmails: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    createdBy: { type: GraphQLString },
    createdAt: { type: JSONScalar },
    updatedAt: { type: JSONScalar },
    signers: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SignerType))) },
    /** The frozen document — only populated on the single-request read. */
    bodyHtml: { type: GraphQLString },
  },
});

const SignerInputType = new GraphQLInputObjectType({
  name: "SignatureSignerInput",
  fields: {
    email: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: GraphQLString },
    role: { type: GraphQLString },
  },
});

const LinkType = new GraphQLObjectType({
  name: "SignatureLink",
  fields: {
    signerId: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const CreatedType = new GraphQLObjectType({
  name: "CreatedSignatureRequest",
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

export const signatureQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  signatureRequests: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RequestType))),
    description:
      "List signature requests in the active workspace (admin-only). `expired` is derived from the expiry timestamp rather than stored, so filtering by it matches requests nothing has swept yet.",
    args: {
      status: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as { status?: string; limit?: number; offset?: number };
        const out = await listSignatureRequests(gqlCtx.ctx, requireFlowAdmin(gqlCtx), {
          ...(a.status ? { status: a.status as SignatureStatus } : {}),
          ...(a.limit != null ? { limit: a.limit } : {}),
          ...(a.offset != null ? { offset: a.offset } : {}),
        });
        return out.data;
      }),
  },
  signatureRequest: {
    type: new GraphQLNonNull(RequestType),
    description:
      "One signature request with every signer's state, including the document as it was frozen (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () =>
        getSignatureRequest(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
};

export const signatureMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createSignatureRequest: {
    type: new GraphQLNonNull(CreatedType),
    description:
      "Freeze a document and send it out for signature (admin-only). Exactly one of `templateKey` or `html`. The plaintext signing links are returned on this response and nowhere else — only their hashes are stored.",
    args: {
      title: { type: GraphQLString },
      message: { type: GraphQLString },
      templateKey: { type: GraphQLString },
      html: { type: GraphQLString },
      vars: { type: JSONScalar },
      pageOptions: { type: JSONScalar },
      filename: { type: GraphQLString },
      signers: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SignerInputType))) },
      ordered: { type: GraphQLBoolean },
      expiresInDays: { type: GraphQLInt },
      writeBack: { type: JSONScalar },
      notifyEmails: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      send: { type: GraphQLBoolean },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as Record<string, unknown>;
        // Restated here because GraphQL args cannot express "exactly one of",
        // and the service would otherwise silently prefer the template.
        if ((a.templateKey == null) === (a.html == null)) {
          throw new AppError("VALIDATION", "Provide exactly one of templateKey or html");
        }
        const created = await createSignatureRequest(
          gqlCtx.ctx,
          tenantId,
          a as never,
          gqlCtx.auth.userId ?? null,
        );
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_signature_requests",
          itemId: created.request.id,
          // The signer addresses, never the links — an activity row is read by
          // more people than the invitation email is.
          payload: { title: created.request.title, signers: created.request.signers.length },
        });
        return created;
      }),
  },
  voidSignatureRequest: {
    type: new GraphQLNonNull(RequestType),
    description:
      "Cancel a signature request (admin-only). Replaces every outstanding token, so links already delivered stop working.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) }, reason: { type: GraphQLString } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { id: string; reason?: string };
        const out = await voidSignatureRequest(gqlCtx.ctx, tenantId, a.id, a.reason ?? null);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_signature_requests",
          itemId: a.id,
          payload: { status: "voided" },
        });
        return out;
      }),
  },
  resendSignatureInvite: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Re-send one signer's invitation with a FRESH link (admin-only). The previous link stops working — a resend that left it live would fix nothing.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      signerId: { type: new GraphQLNonNull(GraphQLID) },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as { id: string; signerId: string };
        return resendSignatureInvite(gqlCtx.ctx, requireFlowAdmin(gqlCtx), a.id, a.signerId);
      }),
  },
  finalizeSignatureRequest: {
    type: new GraphQLNonNull(RequestType),
    description:
      "Produce the signed copy for a request everybody has already signed (admin-only). Recovery for a renderer that was unreachable when the last signature landed — by then every signing link is spent.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () =>
        finalizePendingRequest(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
};
