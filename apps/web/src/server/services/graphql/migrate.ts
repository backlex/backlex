import { AppError } from "@backlex/core";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLError,
  GraphQLNonNull,
  GraphQLString,
  GraphQLList,
  type GraphQLFieldConfig,
} from "graphql";
import {
  buildSourcePlan,
  cancelRun,
  createSource,
  deleteSource,
  getRun,
  listRuns,
  listSources,
  listSourceTables,
  resumeRun,
  startRun,
  testSource,
} from "../migrate";

// ── External-DB migration (docs/migrating-in.md) ─────────────────────────────
// Mirrors REST `/api/admin/migrate` + SDK `client.migrate.*` + MCP `migrate.*`
// + CLI `backlex import-db`. Every resolver calls the ONE shared service —
// guards (SSRF, active-run conflict, source scoping) are never re-implemented
// here. Plans and run state are heterogeneous documents, so they ride the
// JSON scalar.

/** yoga masks non-GraphQLError throws as "Unexpected error." — re-throw the
 *  service's AppErrors as GraphQLErrors so the SSRF guard's (and friends')
 *  actionable messages survive to the client, code preserved. */
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

export const migrateQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  migrateSources: {
    type: new GraphQLNonNull(JSONScalar),
    description: "List saved external-DB sources (URLs masked; admin-only).",
    resolve: (_src, _args, gqlCtx) =>
      requireFlowAdmin(gqlCtx) && surfacing(() => listSources(gqlCtx.ctx, gqlCtx.auth.tenantId as string)),
  },
  migrateRuns: {
    type: new GraphQLNonNull(JSONScalar),
    description: "List external-DB migration runs, newest first (admin-only).",
    resolve: (_src, _args, gqlCtx) =>
      requireFlowAdmin(gqlCtx) && surfacing(() => listRuns(gqlCtx.ctx, gqlCtx.auth.tenantId as string)),
  },
  migrateRun: {
    type: new GraphQLNonNull(JSONScalar),
    description: "One migration run, including live per-table progress (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      return surfacing(() => getRun(gqlCtx.ctx, tenantId, (args as { id: string }).id));
    },
  },
  migrateSourceTables: {
    type: new GraphQLNonNull(JSONScalar),
    description: "List an external source's tables (name + row estimate; admin-only).",
    args: { sourceId: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      return surfacing(() => listSourceTables(gqlCtx.ctx, tenantId, (args as { sourceId: string }).sourceId));
    },
  },
};

export const migrateMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  migrateCreateSource: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Save an external-DB source connection (URL encrypted at rest; admin-only).",
    args: {
      name: { type: new GraphQLNonNull(GraphQLString) },
      url: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { name: string; url: string };
      return surfacing(() =>
        createSource(gqlCtx.ctx, tenantId, {
          name: a.name,
          url: a.url,
          createdBy: gqlCtx.auth.userId ?? null,
        }),
      );
    },
  },
  migrateDeleteSource: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Delete a saved source (refused while a run is in flight; admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      await surfacing(() => deleteSource(gqlCtx.ctx, tenantId, (args as { id: string }).id));
      return { ok: true };
    },
  },
  migrateTestSource: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Connectivity check against a saved source (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      return surfacing(() => testSource(gqlCtx.ctx, tenantId, (args as { id: string }).id));
    },
  },
  migratePlan: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Introspect a saved source and build an editable migration plan (admin-only).",
    args: {
      sourceId: { type: new GraphQLNonNull(GraphQLString) },
      tables: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { sourceId: string; tables?: string[] | null };
      return surfacing(() => buildSourcePlan(gqlCtx.ctx, tenantId, a.sourceId, a.tables ?? undefined));
    },
  },
  migrateStartRun: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Queue a server-side copy run for a (possibly edited) plan (admin-only). One run per workspace at a time.",
    args: {
      sourceId: { type: new GraphQLNonNull(GraphQLString) },
      plan: { type: new GraphQLNonNull(JSONScalar) },
    },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { sourceId: string; plan: unknown };
      return surfacing(() =>
        startRun(gqlCtx.ctx, tenantId, {
          sourceId: a.sourceId,
          plan: a.plan,
          createdBy: gqlCtx.auth.userId ?? null,
        }),
      );
    },
  },
  migrateCancelRun: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Cancel a pending/running migration run (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      return surfacing(() => cancelRun(gqlCtx.ctx, tenantId, (args as { id: string }).id));
    },
  },
  migrateResumeRun: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Re-queue a failed/cancelled run — cursors resume where the copy stopped (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      return surfacing(() => resumeRun(gqlCtx.ctx, tenantId, (args as { id: string }).id));
    },
  },
};
