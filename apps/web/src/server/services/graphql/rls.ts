import { AppError } from "@backlex/core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import { applyRls, disableRls, planRls, rlsStatus } from "../rls";
import { recordActivity } from "../activity";

// ── Row-level security ───────────────────────────────────────────────────────
// Admin mirror of REST `/api/admin/rls`. Every field funnels through
// services/rls.ts, so the owner check, the `standard_conforming_strings` check
// and the omission reporting are shared rather than restated — this is a
// surface that runs DDL, and a guard missing on one of two paths is the whole
// failure mode the parity gate exists for.

const OmissionType = new GraphQLObjectType({
  name: "RlsOmission",
  fields: {
    collection: { type: new GraphQLNonNull(GraphQLString) },
    role: { type: new GraphQLNonNull(GraphQLString) },
    action: { type: new GraphQLNonNull(GraphQLString) },
    reason: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const PolicyType = new GraphQLObjectType({
  name: "RlsPolicy",
  fields: {
    collection: { type: new GraphQLNonNull(GraphQLString) },
    table: { type: new GraphQLNonNull(GraphQLString) },
    role: { type: new GraphQLNonNull(GraphQLString) },
    action: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    statements: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
  },
});

const strings = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString)));

const PlanType = new GraphQLObjectType({
  name: "RlsPlan",
  fields: {
    helpers: { type: strings },
    enables: { type: strings },
    policies: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PolicyType))) },
    omissions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OmissionType))) },
    notOwned: { type: strings },
  },
});

const StatusType = new GraphQLObjectType({
  name: "RlsStatus",
  fields: {
    supported: { type: new GraphQLNonNull(GraphQLBoolean) },
    appliesTo: { type: new GraphQLNonNull(GraphQLString) },
    installed: { type: new GraphQLNonNull(JSONScalar) },
    expected: { type: new GraphQLNonNull(JSONScalar) },
    stale: { type: new GraphQLNonNull(JSONScalar) },
    missing: { type: new GraphQLNonNull(JSONScalar) },
    omissions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OmissionType))) },
    notOwned: { type: strings },
  },
});

const ApplyType = new GraphQLObjectType({
  name: "RlsApplyResult",
  fields: {
    applied: { type: new GraphQLNonNull(GraphQLInt) },
    statements: { type: new GraphQLNonNull(GraphQLInt) },
    tables: { type: strings },
    omissions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OmissionType))) },
  },
});

const DisableType = new GraphQLObjectType({
  name: "RlsDisableResult",
  fields: {
    dropped: { type: new GraphQLNonNull(GraphQLInt) },
    disabled: { type: strings },
  },
});

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

export const rlsQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  rlsStatus: {
    type: new GraphQLNonNull(StatusType),
    description:
      "What row security is installed for this workspace, and how far it has drifted from the " +
      "current permission rules (admin-only).",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(async () => rlsStatus(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
  rlsPlan: {
    type: new GraphQLNonNull(PlanType),
    description:
      "The exact statements an apply would run, plus the omissions — the parts of the permission " +
      "model a policy cannot carry (admin-only). Changes nothing.",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(async () => planRls(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
};

export const rlsMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  applyRls: {
    type: new GraphQLNonNull(ApplyType),
    description:
      "Install the policies (admin-only). Idempotent. Refused when backlex does not own a covered table.",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const res = await applyRls(gqlCtx.ctx, tenantId);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_rls",
          itemId: "apply",
          payload: { applied: res.applied },
        });
        return res;
      }),
  },
  disableRls: {
    type: new GraphQLNonNull(DisableType),
    description:
      "Drop backlex's policies (admin-only). Row security stays on for any table that still " +
      "carries a policy from somewhere else.",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const res = await disableRls(gqlCtx.ctx, tenantId);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_rls",
          itemId: "disable",
          payload: { dropped: res.dropped },
        });
        return res;
      }),
  },
};
