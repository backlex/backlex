import { JSONScalar, type GqlCtx } from "./core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { and, eq, } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  SYSTEM_ROLES,
} from "@backlex/core";
import { runFlowById } from "../flows";

// ── Flows (visual workflows) ────────────────────────────────────────────────
// Static, admin-scoped query/mutation fields. Unlike collections these don't
// vary with tenant schema, so they're merged into EVERY schema (including the
// no-collections one). Mirrors REST `/api/flows` + MCP `flows.*` + the SDK
// `client.flows.*` surface.
const flowsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;

const FlowType = new GraphQLObjectType({
  name: "Flow",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    name: { type: new GraphQLNonNull(GraphQLString) },
    trigger: { type: new GraphQLNonNull(GraphQLString) },
    operations: { type: new GraphQLNonNull(JSONScalar) },
    layout: { type: JSONScalar },
    active: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const FlowInputType = new GraphQLInputObjectType({
  name: "FlowInput",
  fields: {
    name: { type: GraphQLString },
    trigger: { type: GraphQLString },
    operations: { type: JSONScalar },
    layout: { type: JSONScalar },
    active: { type: GraphQLBoolean },
  },
});

const FlowRunResultType = new GraphQLObjectType({
  name: "FlowRunResult",
  fields: {
    ok: { type: new GraphQLNonNull(GraphQLBoolean) },
    error: { type: GraphQLString },
  },
});

/** Flows are admin-only on every other surface (REST + MCP). Mirror that gate
 *  here — non-admins get a FORBIDDEN error, not a silent empty list. Returns
 *  the active tenant id (also requiring one, like the REST route). */
export const requireFlowAdmin = (gqlCtx: GqlCtx): string => {
  const { auth } = gqlCtx;
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new GraphQLError("Admin role required", { extensions: { code: "FORBIDDEN" } });
  }
  if (!auth.tenantId) {
    throw new GraphQLError("Active tenant required", { extensions: { code: "UNAUTHORIZED" } });
  }
  return auth.tenantId;
};

/** sqlite stores `active` as 0/1 — coerce to a real boolean for the schema. */
const normalizeFlowRow = (r: Record<string, unknown>) => ({
  ...r,
  active: Boolean(r.active),
});

const listFlowsResolver = async (gqlCtx: GqlCtx) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const t = flowsTable(gqlCtx.ctx.dialect);
  const rows = (await (gqlCtx.ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))) as Record<string, unknown>[];
  return rows.map(normalizeFlowRow);
};

const getFlowResolver = async (gqlCtx: GqlCtx, id: string) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const t = flowsTable(gqlCtx.ctx.dialect);
  const rows = (await (gqlCtx.ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as Record<string, unknown>[];
  return rows[0] ? normalizeFlowRow(rows[0]) : null;
};

const createFlowResolver = async (
  gqlCtx: GqlCtx,
  data: Record<string, unknown>,
) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  if (typeof data?.name !== "string" || data.name.length === 0) {
    throw new GraphQLError("name is required", { extensions: { code: "VALIDATION" } });
  }
  if (typeof data.trigger !== "string" || data.trigger.length === 0) {
    throw new GraphQLError("trigger is required", { extensions: { code: "VALIDATION" } });
  }
  if (!Array.isArray(data.operations) || data.operations.length === 0) {
    throw new GraphQLError("operations must be a non-empty array", {
      extensions: { code: "VALIDATION" },
    });
  }
  const t = flowsTable(gqlCtx.ctx.dialect);
  const id = crypto.randomUUID();
  await (gqlCtx.ctx.db as any).insert(t).values({
    id,
    tenantId,
    name: data.name,
    trigger: data.trigger,
    operations: data.operations,
    layout: data.layout ?? null,
    active: data.active ?? true,
  });
  return getFlowResolver(gqlCtx, id);
};

const updateFlowResolver = async (
  gqlCtx: GqlCtx,
  id: string,
  data: Record<string, unknown>,
) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const { ctx } = gqlCtx;
  const t = flowsTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.trigger !== undefined ? { trigger: data.trigger } : {}),
      ...(data.operations !== undefined ? { operations: data.operations } : {}),
      ...(data.layout !== undefined ? { layout: data.layout } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
    })
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
  return getFlowResolver(gqlCtx, id);
};

const deleteFlowResolver = async (gqlCtx: GqlCtx, id: string) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const t = flowsTable(gqlCtx.ctx.dialect);
  await (gqlCtx.ctx.db as any)
    .delete(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
  return true;
};

const runFlowResolver = async (
  gqlCtx: GqlCtx,
  id: string,
  input: unknown,
) => {
  const tenantId = requireFlowAdmin(gqlCtx);
  const { ctx, auth } = gqlCtx;
  // Verify the flow belongs to the active workspace before running —
  // runFlowById doesn't tenant-check on its own (mirrors the REST route).
  const t = flowsTable(ctx.dialect);
  const own = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as { id: string }[];
  if (!own[0]) {
    throw new GraphQLError("Flow not found", { extensions: { code: "NOT_FOUND" } });
  }
  const payload =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const result = await runFlowById(ctx, id, payload, auth);
  return { ok: result.ok, error: result.error ?? undefined };
};

/** Static flow query fields, merged into every schema. */
export const flowQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  flows: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(FlowType))),
    description: "List visual workflows in the active workspace (admin-only).",
    resolve: (_src, _args, gqlCtx) => listFlowsResolver(gqlCtx),
  },
  flow: {
    type: FlowType,
    description: "Fetch a single flow's full definition by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_src, args, gqlCtx) => getFlowResolver(gqlCtx, (args as { id: string }).id),
  },
};

/** Static flow mutation fields, merged into every schema. */
export const flowMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createFlow: {
    type: FlowType,
    description: "Create a flow scoped to the active workspace (admin-only).",
    args: { data: { type: new GraphQLNonNull(FlowInputType) } },
    resolve: (_src, args, gqlCtx) =>
      createFlowResolver(gqlCtx, (args as { data: Record<string, unknown> }).data),
  },
  updateFlow: {
    type: FlowType,
    description: "Partial update of a flow by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(FlowInputType) },
    },
    resolve: (_src, args, gqlCtx) =>
      updateFlowResolver(
        gqlCtx,
        (args as { id: string }).id,
        (args as { data: Record<string, unknown> }).data,
      ),
  },
  deleteFlow: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete a flow by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_src, args, gqlCtx) => deleteFlowResolver(gqlCtx, (args as { id: string }).id),
  },
  runFlow: {
    type: new GraphQLNonNull(FlowRunResultType),
    description:
      "Run a flow synchronously with an arbitrary `input` trigger payload (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      input: { type: JSONScalar },
    },
    resolve: (_src, args, gqlCtx) =>
      runFlowResolver(gqlCtx, (args as { id: string }).id, (args as { input?: unknown }).input),
  },
};

