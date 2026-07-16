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
import { cloneCollection as cloneCollectionService } from "../collections";
import { invalidateTenantCollections } from "../collections-cache";

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
  cloneCollection: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Clone a collection's schema (fields + metadata, never data) into a new managed collection (admin-only). Mirrors REST `POST /api/collections/:slug/clone`.",
    args: {
      slug: { type: new GraphQLNonNull(GraphQLString) },
      newSlug: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const a = args as { slug: string; newSlug: string };
      if (!/^[a-z][a-z0-9_]*$/.test(a.newSlug) || a.newSlug.length > 120) {
        throw new GraphQLError("newSlug must match ^[a-z][a-z0-9_]*$", {
          extensions: { code: "VALIDATION" },
        });
      }
      try {
        const res = await cloneCollectionService(
          { db: gqlCtx.ctx.db, dialect: gqlCtx.ctx.dialect },
          tenantId,
          a.slug,
          a.newSlug,
        );
        invalidateTenantCollections(tenantId);
        return res;
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === "SOURCE_NOT_FOUND") {
          throw new GraphQLError("Collection not found", { extensions: { code: "NOT_FOUND" } });
        }
        if (msg === "SLUG_TAKEN") {
          throw new GraphQLError(`Collection slug "${a.newSlug}" already exists`, {
            extensions: { code: "CONFLICT" },
          });
        }
        throw e;
      }
    },
  },
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
