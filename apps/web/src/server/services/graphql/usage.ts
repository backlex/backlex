import { AppError } from "@backlex/core";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { listApiKeys } from "../api-keys";
import { saveUsageLimits, usageExport, usageOverview } from "../usage";

// ── Usage metering (#12) ─────────────────────────────────────────────────────
// Admin-scoped twin of REST `/api/admin/usage` + MCP `usage.*` + SDK
// `client.usage.*`. Both fields call the SAME service assembly
// (`usageOverview` / `saveUsageLimits`) so gating and shaping live once.
// The overview is returned as a JSON scalar — it's a dashboard payload, not
// a graph to sub-select.

const requireUsageAdmin = requireFlowAdmin;

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

export const usageQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  usageOverview: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Workspace usage overview: per-day request/error series, per-API-key month totals, storage/row gauges, effective limits (admin-only).",
    args: { days: { type: GraphQLInt } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireUsageAdmin(gqlCtx);
      const days = Math.min(90, Math.max(1, (args as { days?: number }).days ?? 30));
      const keys = await listApiKeys(gqlCtx.ctx, tenantId, null);
      return surfaceAppError(() =>
        usageOverview(gqlCtx.ctx, tenantId, days, keys),
      );
    },
  },
  usageExport: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Raw usage-ledger rows for billing reconciliation — one per (day, API key), " +
      "buffer flushed first. Defaults to the current UTC month-to-date (admin-only).",
    args: { from: { type: GraphQLString }, to: { type: GraphQLString } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireUsageAdmin(gqlCtx);
      const { from, to } = args as { from?: string | null; to?: string | null };
      const keys = await listApiKeys(gqlCtx.ctx, tenantId, null);
      return surfaceAppError(() =>
        usageExport(gqlCtx.ctx, tenantId, { from, to }, keys),
      );
    },
  },
};

export const usageMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  usageSetLimits: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      "Persist the workspace's admin-editable usage limits. `USAGE_LIMIT_*` env pins still win at enforcement time (admin-only).",
    args: { limits: { type: new GraphQLNonNull(JSONScalar) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireUsageAdmin(gqlCtx);
      const raw = (args as { limits: Record<string, unknown> }).limits;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new GraphQLError("limits must be an object", {
          extensions: { code: "VALIDATION" },
        });
      }
      const mode = raw.mode;
      if (mode !== "off" && mode !== "soft" && mode !== "hard") {
        throw new GraphQLError("limits.mode must be off | soft | hard", {
          extensions: { code: "VALIDATION" },
        });
      }
      const posOrNull = (v: unknown, label: string): number | null => {
        if (v === null || v === undefined) return null;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
          throw new GraphQLError(`limits.${label} must be a positive integer or null`, {
            extensions: { code: "VALIDATION" },
          });
        }
        return Math.floor(v);
      };
      await surfaceAppError(() =>
        saveUsageLimits(gqlCtx.ctx, tenantId, {
          mode,
          maxRequestsPerMonth: posOrNull(raw.maxRequestsPerMonth, "maxRequestsPerMonth"),
          maxStorageBytes: posOrNull(raw.maxStorageBytes, "maxStorageBytes"),
          maxDbRows: posOrNull(raw.maxDbRows, "maxDbRows"),
        }),
      );
      return true;
    },
  },
};
