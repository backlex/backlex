import { JSONScalar, type GqlCtx } from "./core";
import { resolveCallerMcpGuards } from "../roles/mcp-guards";
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
import { sendMessage } from "../agents/send";
import {
  forgetFact,
  listFacts,
  parseMemoryScope,
  rememberFact,
} from "../agents/memory";
import { allTools } from "../../mcp/tools";

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
    /** Stable `@`-mention token used in rooms. */
    handle: { type: GraphQLString },
    description: { type: GraphQLString },
    systemPrompt: { type: GraphQLString },
    model: { type: GraphQLString },
    tools: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    /** Tool-name globs whose calls need a person's approval. Empty = no gate. */
    approvalTools: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    /** `[{ email, name? }]`. JSON rather than a declared object type because it
     *  is a small opaque shape the server validates, and half a gate — the
     *  patterns without the people to ask — would be worse than none. */
    approvers: { type: JSONScalar },
    maxSteps: { type: new GraphQLNonNull(GraphQLInt) },
    memory: { type: new GraphQLNonNull(GraphQLBoolean) },
    /** `thread` | `agent` — how far distilled semantic facts reach. */
    memoryScope: { type: new GraphQLNonNull(GraphQLString) },
    active: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

/** One durable fact an agent holds. Mirrors `agent_memories`. */
const AgentMemoryType = new GraphQLObjectType({
  name: "AgentMemory",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    agentId: { type: new GraphQLNonNull(GraphQLID) },
    threadId: { type: GraphQLID },
    scope: { type: new GraphQLNonNull(GraphQLString) },
    content: { type: new GraphQLNonNull(GraphQLString) },
    /** False when the fact was stored with no embedding provider available —
     *  it's listable and forgettable, but not retrievable by similarity. */
    embedded: { type: new GraphQLNonNull(GraphQLBoolean) },
    hits: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const AgentInputType = new GraphQLInputObjectType({
  name: "AgentInput",
  fields: {
    name: { type: GraphQLString },
    handle: { type: GraphQLString },
    description: { type: GraphQLString },
    systemPrompt: { type: GraphQLString },
    model: { type: GraphQLString },
    tools: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    approvalTools: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    approvers: { type: JSONScalar },
    maxSteps: { type: GraphQLInt },
    memory: { type: GraphQLBoolean },
    memoryScope: { type: GraphQLString },
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
  memoryScope: r.memoryScope === "agent" ? "agent" : "thread",
  active: Boolean(r.active),
  tools: Array.isArray(r.tools) ? r.tools : [],
  approvalTools: Array.isArray(r.approvalTools) ? r.approvalTools : [],
  approvers: Array.isArray(r.approvers) ? r.approvers : [],
});

const normalizeMemoryRow = (r: Record<string, unknown>) => ({
  ...r,
  embedded: Boolean(r.embedded),
  hits: Number(r.hits ?? 0),
});

/** Reject a memoryScope that isn't one of the two the schema allows, rather
 *  than silently coercing it — a typo'd `"global"` would otherwise read as
 *  `thread` and quietly not do what the caller asked. */
const validateMemoryScope = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  if (v !== "thread" && v !== "agent") {
    throw new GraphQLError("memoryScope must be 'thread' or 'agent'", {
      extensions: { code: "VALIDATION" },
    });
  }
  return v;
};

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
  agentMemories: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AgentMemoryType))),
    description:
      "The durable facts an agent has learned, newest first (admin-only). " +
      "Pass `threadId` to see only what was learned in one conversation.",
    args: {
      agentId: { type: new GraphQLNonNull(GraphQLID) },
      threadId: { type: GraphQLID },
      limit: { type: GraphQLInt },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const a = args as { agentId: string; threadId?: string; limit?: number };
      // Ownership check first: `listFacts` keys on agentId alone, so without
      // this a cross-tenant id would read another workspace's memory.
      const agent = await getAgentRow(gqlCtx.ctx, a.agentId, tenantId);
      if (!agent) {
        throw new GraphQLError("Agent not found", { extensions: { code: "NOT_FOUND" } });
      }
      const rows = await listFacts(gqlCtx.ctx, a.agentId, {
        threadId: a.threadId ?? null,
        limit: a.limit,
      });
      return rows.map((r) => normalizeMemoryRow(r as unknown as Record<string, unknown>));
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
      const memoryScope = validateMemoryScope(data.memoryScope);
      const row = await createAgentRow(gqlCtx.ctx, tenantId, {
        name: data.name,
        description: (data.description as string) ?? null,
        systemPrompt: (data.systemPrompt as string) ?? null,
        model: (data.model as string) ?? null,
        ...(tools ? { tools } : {}),
        ...(data.maxSteps !== undefined ? { maxSteps: Number(data.maxSteps) } : {}),
        ...(data.memory !== undefined ? { memory: Boolean(data.memory) } : {}),
        ...(memoryScope ? { memoryScope } : {}),
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
      const memoryScope = validateMemoryScope(data.memoryScope);
      await updateAgentRow(gqlCtx.ctx, id, tenantId, {
        ...(data.name !== undefined ? { name: data.name as string } : {}),
        ...(data.description !== undefined ? { description: data.description as string } : {}),
        ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt as string } : {}),
        ...(data.model !== undefined ? { model: data.model as string } : {}),
        ...(tools ? { tools } : {}),
        ...(data.maxSteps !== undefined ? { maxSteps: Number(data.maxSteps) } : {}),
        ...(data.memory !== undefined ? { memory: Boolean(data.memory) } : {}),
        ...(memoryScope ? { memoryScope } : {}),
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
  rememberAgentFact: {
    type: AgentMemoryType,
    description:
      "Teach an agent one durable fact directly (admin-only). Deduped against " +
      "what it already knows — a restatement returns null rather than erroring. " +
      "`threadId` is required while the agent's memoryScope is `thread`.",
    args: {
      agentId: { type: new GraphQLNonNull(GraphQLID) },
      content: { type: new GraphQLNonNull(GraphQLString) },
      threadId: { type: GraphQLID },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const a = args as { agentId: string; content: string; threadId?: string };
      const agent = await getAgentRow(gqlCtx.ctx, a.agentId, tenantId);
      if (!agent) {
        throw new GraphQLError("Agent not found", { extensions: { code: "NOT_FOUND" } });
      }
      const scope = parseMemoryScope(agent.memoryScope);
      if (scope === "thread" && !a.threadId) {
        throw new GraphQLError(
          "threadId is required while this agent's memoryScope is 'thread'",
          { extensions: { code: "VALIDATION" } },
        );
      }
      const row = await rememberFact(gqlCtx.ctx, {
        tenantId,
        agentId: a.agentId,
        threadId: a.threadId ?? "",
        scope,
        content: a.content,
      });
      return row ? normalizeMemoryRow(row as unknown as Record<string, unknown>) : null;
    },
  },
  forgetAgentMemory: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      "Delete one remembered fact by id, from both the table and the vector " +
      "index (admin-only). False when the id doesn't belong to the agent.",
    args: {
      agentId: { type: new GraphQLNonNull(GraphQLID) },
      memoryId: { type: new GraphQLNonNull(GraphQLID) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const a = args as { agentId: string; memoryId: string };
      const agent = await getAgentRow(gqlCtx.ctx, a.agentId, tenantId);
      if (!agent) {
        throw new GraphQLError("Agent not found", { extensions: { code: "NOT_FOUND" } });
      }
      return await forgetFact(gqlCtx.ctx, a.agentId, a.memoryId);
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
      // Through the same service every other surface uses, with the named
      // agent forced: `runAgent` names its agent, so a room's routing mode must
      // not decide otherwise.
      const result = await sendMessage({
        ctx,
        app,
        env: ctx.env,
        tenantId,
        threadId,
        message: a.message,
        auth: {
          userId: gqlCtx.auth.userId,
          // Same seam, same resolution as the REST route — GraphQL is a
          // surface, not a second security model.
          guards: await resolveCallerMcpGuards(ctx, gqlCtx.auth),
        },
        request: rawRequest,
        forceAgentIds: [a.agent],
      });
      const turn = result.turns[0];
      return {
        answer: turn?.answer ?? "",
        steps: turn?.steps ?? [],
        stoppedReason: turn?.stoppedReason ?? "final",
        threadId,
      };
    },
  },
};

