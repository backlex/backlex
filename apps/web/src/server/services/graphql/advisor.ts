import { AppError } from "@backlex/core";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLError,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { applyAdvisorFix, runAdvisorChecks } from "../advisor";
import { loadRuntimeInsights } from "../advisor-insights";

// ── Advisor (#20) ────────────────────────────────────────────────────────────
// Admin-scoped twin of REST `/api/admin/advisor*` + MCP `advisor-*` + SDK
// `client.advisor.*`. Every field calls the SAME service assembly
// (`runAdvisorChecks` / `loadRuntimeInsights` / `applyAdvisorFix`), so the
// "re-derive the statement, never trust the caller" rule for `advisorApply`
// lives in exactly one place. Results are JSON scalars — they're report
// payloads, not graphs to sub-select.

const requireAdvisorAdmin = requireFlowAdmin;

const surfaceAppError = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

export const advisorQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  advisor: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Run the advisor: security + performance findings for the active workspace, a 0–100 score, and the runtime window the traffic-derived rules used (admin-only).",
    args: { days: { type: GraphQLInt } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAdvisorAdmin(gqlCtx);
      const { days } = args as { days?: number };
      return surfaceAppError(() =>
        runAdvisorChecks(
          {
            db: gqlCtx.ctx.db,
            dialect: gqlCtx.ctx.dialect,
            env: gqlCtx.ctx.env,
            image: gqlCtx.ctx.image,
            edgeImage: gqlCtx.ctx.edgeImage,
          },
          tenantId,
          { windowDays: days },
        ),
      );
    },
  },
  advisorInsights: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Runtime query insights aggregated from recorded spans: per-endpoint latency percentiles and error rates, per-collection list traffic and the columns it filters / sorts on, and `permissionWriteChecks` — the writes that landed outside their role's `write` conditions, which is what says whether `PERMISSION_WRITE_CHECK=enforce` would refuse anything. `window.sampleRate` below 1 means the numbers describe a sample (admin-only).",
    args: { days: { type: GraphQLInt }, limit: { type: GraphQLInt } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAdvisorAdmin(gqlCtx);
      const { days, limit } = args as { days?: number; limit?: number };
      return surfaceAppError(() =>
        loadRuntimeInsights(
          {
            db: gqlCtx.ctx.db,
            dialect: gqlCtx.ctx.dialect,
            env: gqlCtx.ctx.env,
          },
          tenantId,
          { days, limit },
        ),
      );
    },
  },
};

export const advisorMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  advisorApply: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Apply the remediation attached to a finding (today: `CREATE INDEX IF NOT EXISTS`). The statement is re-derived server-side from a fresh advisor run and matched by `id` — it is never taken from the caller. Findings with no automatic fix are rejected (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      days: { type: GraphQLInt },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAdvisorAdmin(gqlCtx);
      const { id, days } = args as { id: string; days?: number };
      return surfaceAppError(() =>
        applyAdvisorFix(
          {
            db: gqlCtx.ctx.db,
            dialect: gqlCtx.ctx.dialect,
            env: gqlCtx.ctx.env,
            image: gqlCtx.ctx.image,
            edgeImage: gqlCtx.ctx.edgeImage,
          },
          tenantId,
          { id, windowDays: days, userId: gqlCtx.auth.userId ?? null },
        ),
      );
    },
  },
};
