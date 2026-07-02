import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
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
import {
  createAgent as createAgentRow,
  deleteAgent as deleteAgentRow,
  getAgent as getAgentRow,
  listAgents as listAgentRows,
  updateAgent as updateAgentRow,
  createThread as createAgentThreadRow,
  getThread as getAgentThreadRow,
} from "../agents/store";
import { runAgentTurn } from "../agents/runner";
import { allTools } from "../../mcp/tools";
import { makeInternalFetch } from "../../mcp/internal-fetch";

// ── AI agents ────────────────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/agents` + MCP `agents.*` +
// SDK `client.agents.*`. CRUD + a `runAgent` mutation that runs one turn (same
// altitude as flows' `runFlow`). Threads/transcripts stay REST/SDK-only.

const AgentType = new GraphQLObjectType({
  name: "Agent",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    systemPrompt: { type: GraphQLString },
    model: { type: GraphQLString },
    tools: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    maxSteps: { type: new GraphQLNonNull(GraphQLInt) },
    memory: { type: new GraphQLNonNull(GraphQLBoolean) },
    active: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const AgentInputType = new GraphQLInputObjectType({
  name: "AgentInput",
  fields: {
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    systemPrompt: { type: GraphQLString },
    model: { type: GraphQLString },
    tools: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    maxSteps: { type: GraphQLInt },
    memory: { type: GraphQLBoolean },
    active: { type: GraphQLBoolean },
  },
});

const AgentRunStepType = new GraphQLObjectType({
  name: "AgentRunStep",
  fields: {
    thought: { type: GraphQLString },
    tool: { type: new GraphQLNonNull(GraphQLString) },
    args: { type: new GraphQLNonNull(JSONScalar) },
    observation: { type: new GraphQLNonNull(GraphQLString) },
    isError: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const AgentRunResultType = new GraphQLObjectType({
  name: "AgentRunResult",
  fields: {
    answer: { type: new GraphQLNonNull(GraphQLString) },
    threadId: { type: new GraphQLNonNull(GraphQLID) },
    stoppedReason: { type: new GraphQLNonNull(GraphQLString) },
    steps: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AgentRunStepType))) },
  },
});

/** Agents are admin-only on every other surface — mirror that gate (reusing the
 *  flow gate's identical admin + active-tenant check). */
export const requireAgentAdmin = requireFlowAdmin;

/** sqlite stores booleans as 0/1 — coerce for the schema. */
const normalizeAgentRow = (r: Record<string, unknown>) => ({
  ...r,
  memory: Boolean(r.memory),
  active: Boolean(r.active),
  tools: Array.isArray(r.tools) ? r.tools : [],
});

const validateAgentTools = (tools: unknown): string[] | undefined => {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) {
    throw new GraphQLError("tools must be an array of tool names", {
      extensions: { code: "VALIDATION" },
    });
  }
  const known = new Set(allTools.map((t) => t.name));
  const unknown = (tools as string[]).filter((t) => !known.has(t));
  if (unknown.length) {
    throw new GraphQLError(`unknown tool(s): ${unknown.join(", ")}`, {
      extensions: { code: "VALIDATION" },
    });
  }
  return tools as string[];
};

export const agentQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  agents: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AgentType))),
    description: "List AI agents in the active workspace (admin-only).",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const rows = await listAgentRows(gqlCtx.ctx, tenantId);
      return rows.map((r) => normalizeAgentRow(r as unknown as Record<string, unknown>));
    },
  },
  agent: {
    type: AgentType,
    description: "Fetch a single agent by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const row = await getAgentRow(gqlCtx.ctx, (args as { id: string }).id, tenantId);
      return row ? normalizeAgentRow(row as unknown as Record<string, unknown>) : null;
    },
  },
};

export const agentMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createAgent: {
    type: AgentType,
    description: "Create an agent scoped to the active workspace (admin-only).",
    args: { data: { type: new GraphQLNonNull(AgentInputType) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const data = (args as { data: Record<string, unknown> }).data;
      if (typeof data?.name !== "string" || data.name.length === 0) {
        throw new GraphQLError("name is required", { extensions: { code: "VALIDATION" } });
      }
      const tools = validateAgentTools(data.tools);
      const row = await createAgentRow(gqlCtx.ctx, tenantId, {
        name: data.name,
        description: (data.description as string) ?? null,
        systemPrompt: (data.systemPrompt as string) ?? null,
        model: (data.model as string) ?? null,
        ...(tools ? { tools } : {}),
        ...(data.maxSteps !== undefined ? { maxSteps: Number(data.maxSteps) } : {}),
        ...(data.memory !== undefined ? { memory: Boolean(data.memory) } : {}),
        ...(data.active !== undefined ? { active: Boolean(data.active) } : {}),
      });
      return normalizeAgentRow(row as unknown as Record<string, unknown>);
    },
  },
  updateAgent: {
    type: AgentType,
    description: "Partial update of an agent by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(AgentInputType) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const id = (args as { id: string }).id;
      const data = (args as { data: Record<string, unknown> }).data;
      const tools = validateAgentTools(data.tools);
      await updateAgentRow(gqlCtx.ctx, id, tenantId, {
        ...(data.name !== undefined ? { name: data.name as string } : {}),
        ...(data.description !== undefined ? { description: data.description as string } : {}),
        ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt as string } : {}),
        ...(data.model !== undefined ? { model: data.model as string } : {}),
        ...(tools ? { tools } : {}),
        ...(data.maxSteps !== undefined ? { maxSteps: Number(data.maxSteps) } : {}),
        ...(data.memory !== undefined ? { memory: Boolean(data.memory) } : {}),
        ...(data.active !== undefined ? { active: Boolean(data.active) } : {}),
      });
      const row = await getAgentRow(gqlCtx.ctx, id, tenantId);
      return row ? normalizeAgentRow(row as unknown as Record<string, unknown>) : null;
    },
  },
  deleteAgent: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete an agent by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      await deleteAgentRow(gqlCtx.ctx, (args as { id: string }).id, tenantId);
      return true;
    },
  },
  runAgent: {
    type: new GraphQLNonNull(AgentRunResultType),
    description:
      "Send a message to an agent and run one turn to completion. Omit " +
      "`threadId` to start a fresh thread (admin-only).",
    args: {
      agent: { type: new GraphQLNonNull(GraphQLID) },
      message: { type: new GraphQLNonNull(GraphQLString) },
      threadId: { type: GraphQLID },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const { ctx, app, rawRequest } = gqlCtx;
      if (!app || !rawRequest) {
        throw new GraphQLError("agent run is unavailable in this context", {
          extensions: { code: "UNAVAILABLE" },
        });
      }
      const a = args as { agent: string; message: string; threadId?: string };
      const agentRow = await getAgentRow(ctx, a.agent, tenantId);
      if (!agentRow) {
        throw new GraphQLError("Agent not found", { extensions: { code: "NOT_FOUND" } });
      }
      let threadId = a.threadId ?? "";
      if (threadId) {
        const t = await getAgentThreadRow(ctx, threadId, tenantId);
        if (!t) throw new GraphQLError("Thread not found", { extensions: { code: "NOT_FOUND" } });
      } else {
        const t = await createAgentThreadRow(ctx, tenantId, a.agent, {
          createdBy: gqlCtx.auth.userId,
        });
        threadId = t.id;
      }
      const fetchInternal = makeInternalFetch(app, rawRequest, ctx.env);
      const result = await runAgentTurn({
        ctx,
        agentId: a.agent,
        threadId,
        tenantId,
        message: a.message,
        fetchInternal,
        auth: { userId: gqlCtx.auth.userId },
      });
      return { ...result, threadId };
    },
  },
};

