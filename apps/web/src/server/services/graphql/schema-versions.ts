import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLNonNull,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import {
  applySchema as applySchemaVersions,
  captureSnapshot as captureSchemaSnapshot,
  diff as diffSchemaVersions,
  listBranches as listSchemaBranches,
  listSnapshots as listSchemaSnapshots,
  type SchemaRef,
} from "../schema-versions";

// ── Schema versions (migration diffing / schema branching, #9) ──────────────
// Mirrors REST `/api/admin/schema` + MCP `schema.*` + SDK `client.schema.*` +
// CLI `backlex schema`. Diff/apply results are heterogeneous (category counts,
// per-change DDL), so they ride the JSON scalar rather than a deep type graph.
const asSchemaRef = (raw: unknown, label: string): SchemaRef => {
  const r = (raw ?? {}) as { kind?: string; id?: string };
  if (r.kind === "live") return { kind: "live" };
  if ((r.kind === "snapshot" || r.kind === "branch") && r.id) return { kind: r.kind, id: r.id };
  throw new GraphQLError(`${label} must be { kind: "live" } | { kind: "snapshot"|"branch", id }`, {
    extensions: { code: "VALIDATION" },
  });
};

export const schemaVersionQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  schemaSnapshots: {
    type: new GraphQLNonNull(JSONScalar),
    description: "List schema snapshots (migration checkpoints) in the active workspace (admin-only).",
    resolve: (_src, _args, gqlCtx) => requireFlowAdmin(gqlCtx) && listSchemaSnapshots(gqlCtx.ctx, gqlCtx.auth.tenantId as string),
  },
  schemaBranches: {
    type: new GraphQLNonNull(JSONScalar),
    description: "List schema branches in the active workspace (admin-only).",
    resolve: (_src, _args, gqlCtx) => requireFlowAdmin(gqlCtx) && listSchemaBranches(gqlCtx.ctx, gqlCtx.auth.tenantId as string),
  },
};

export const schemaVersionMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  captureSchemaSnapshot: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Capture the live schema as a named snapshot (admin-only).",
    args: { name: { type: new GraphQLNonNull(GraphQLString) }, note: { type: GraphQLString } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { name: string; note?: string | null };
      return captureSchemaSnapshot(gqlCtx.ctx, tenantId, {
        name: a.name,
        note: a.note ?? null,
        createdBy: gqlCtx.auth.userId ?? null,
      });
    },
  },
  schemaDiff: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Diff two schema refs into a categorized change list (admin-only).",
    args: { from: { type: new GraphQLNonNull(JSONScalar) }, to: { type: new GraphQLNonNull(JSONScalar) } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { from: unknown; to: unknown };
      return diffSchemaVersions(gqlCtx.ctx, tenantId, asSchemaRef(a.from, "from"), asSchemaRef(a.to, "to"));
    },
  },
  schemaApply: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Apply a target schema ref to the live schema (admin-only). Destructive changes require confirmDestructive.",
    args: {
      target: { type: new GraphQLNonNull(JSONScalar) },
      confirmDestructive: { type: GraphQLBoolean },
    },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { target: unknown; confirmDestructive?: boolean };
      return applySchemaVersions(gqlCtx.ctx, tenantId, {
        target: asSchemaRef(a.target, "target"),
        confirmDestructive: Boolean(a.confirmDestructive),
        createdBy: gqlCtx.auth.userId ?? null,
      });
    },
  },
};
