import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listAgents: McpTool = {
  name: "agents.list",
  description:
    "List AI agents in the active workspace. Each row shows id, name, model, " +
    "tool allow-list, and whether memory is on. Use `agents.run` to chat with one.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  kind: "read",
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/agents`);
    return textResult(await readJson<unknown>(res));
  },
};

export const getAgent: McpTool = {
  name: "agents.get",
  description: "Fetch a single agent's full definition by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  kind: "read",
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/agents/${encodeURIComponent(id)}`);
    return textResult(await readJson<unknown>(res));
  },
};

export const runAgent: McpTool = {
  name: "agents.run",
  description:
    "Send a message to an agent and run one turn to completion. Pass `agent` " +
    "(the agent id) and `message`. Omit `threadId` to start a fresh thread, or " +
    "pass one to continue an existing conversation. Returns " +
    "`{ answer, steps, stoppedReason, threadId }`.",
  inputSchema: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent id." },
      message: { type: "string", description: "The user message for this turn." },
      threadId: {
        type: "string",
        description: "Existing thread to continue. Omit to start a new one.",
      },
    },
    required: ["agent", "message"],
    additionalProperties: false,
  },
  kind: "write",
  handler: async (args, ctx) => {
    const agent = String(args.agent ?? "");
    const message = String(args.message ?? "");
    if (!agent) throw new Error("VALIDATION: agent is required");
    if (!message) throw new Error("VALIDATION: message is required");

    let threadId = typeof args.threadId === "string" ? args.threadId : "";
    if (!threadId) {
      const created = await ctx.fetchInternal(
        `/api/agents/${encodeURIComponent(agent)}/threads`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = await readJson<{ data: { id: string } }>(created);
      threadId = body.data.id;
    }

    const res = await ctx.fetchInternal(
      `/api/agents/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The named agent answers even if the thread is a room whose routing
        // mode would otherwise wait for an `@mention`.
        body: JSON.stringify({ message, agentIds: [agent] }),
      },
    );
    const body = (await res.json().catch(() => null)) as
      | { data?: Record<string, unknown> }
      | null;
    if (!body) {
      throw new Error(`agents.run: upstream returned non-JSON (status ${res.status})`);
    }
    const out = { ...(body.data ?? body), threadId };
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out,
      isError: !res.ok,
    };
  },
};

export const listRooms: McpTool = {
  name: "agents.rooms_list",
  description:
    "List the workspace's agent conversations (rooms), newest activity first. " +
    "Each row carries its participant agent ids and its routing mode " +
    "(`mention` | `default` | `auto`). Use `agents.room_send` to post in one.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  kind: "read",
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/agents/threads`);
    return textResult(await readJson<unknown>(res));
  },
};

export const sendToRoom: McpTool = {
  name: "agents.room_send",
  description:
    "Post a message in a room and run whichever agents it wakes. Mention an " +
    "agent by its handle (`@sales-bot`) to address it directly; otherwise the " +
    "room's routing mode decides. A room on `mention` routing with no mention " +
    "simply records the message and nobody answers. Returns the persisted " +
    "message id plus each turn's answer.",
  inputSchema: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "Room (thread) id." },
      message: {
        type: "string",
        description: "The message. Use @handle to address an agent.",
      },
    },
    required: ["threadId", "message"],
    additionalProperties: false,
  },
  kind: "write",
  handler: async (args, ctx) => {
    const threadId = String(args.threadId ?? "");
    const message = String(args.message ?? "");
    if (!threadId) throw new Error("VALIDATION: threadId is required");
    if (!message) throw new Error("VALIDATION: message is required");
    const res = await ctx.fetchInternal(
      `/api/agents/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const listAgentMemory: McpTool = {
  name: "agents.memory_list",
  description:
    "List the durable facts an agent has learned (its semantic memory). " +
    "These are distilled from past conversations, not the transcript itself — " +
    "use `agents.rooms_list` for that. Pass `threadId` to see only what was " +
    "learned in one conversation.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent id." },
      threadId: {
        type: "string",
        description: "Narrow to one conversation's pool. Omit for everything.",
      },
      limit: { type: "number", description: "Max rows (default 100, max 200)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  kind: "read",
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const qs = new URLSearchParams();
    if (typeof args.threadId === "string" && args.threadId)
      qs.set("threadId", args.threadId);
    if (typeof args.limit === "number") qs.set("limit", String(args.limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    const res = await ctx.fetchInternal(
      `/api/agents/${encodeURIComponent(id)}/memory${suffix}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const rememberAgentFact: McpTool = {
  name: "agents.memory_add",
  description:
    "Teach an agent one durable fact directly, without waiting for it to be " +
    "distilled from a conversation. Write a single self-contained sentence. " +
    "Deduped against what the agent already knows, so re-teaching is a no-op. " +
    "`threadId` is required while the agent's memoryScope is `thread`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent id." },
      content: { type: "string", description: "The fact, as one sentence." },
      threadId: {
        type: "string",
        description: "Conversation the fact belongs to (thread-scoped agents).",
      },
    },
    required: ["id", "content"],
    additionalProperties: false,
  },
  kind: "write",
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    const content = String(args.content ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    if (!content) throw new Error("VALIDATION: content is required");
    const res = await ctx.fetchInternal(
      `/api/agents/${encodeURIComponent(id)}/memory`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          ...(typeof args.threadId === "string" ? { threadId: args.threadId } : {}),
        }),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const forgetAgentMemory: McpTool = {
  name: "agents.memory_forget",
  description:
    "Delete one remembered fact by its id (from `agents.memory_list`). Removes " +
    "both the row and its embedding, so the agent stops retrieving it.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent id." },
      memoryId: { type: "string", description: "Memory row id." },
    },
    required: ["id", "memoryId"],
    additionalProperties: false,
  },
  kind: "destruct",
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    const memoryId = String(args.memoryId ?? "");
    if (!id || !memoryId)
      throw new Error("VALIDATION: id and memoryId are required");
    const res = await ctx.fetchInternal(
      `/api/agents/${encodeURIComponent(id)}/memory/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const agentsTools: McpTool[] = [
  listAgents,
  getAgent,
  runAgent,
  listRooms,
  sendToRoom,
  listAgentMemory,
  rememberAgentFact,
  forgetAgentMemory,
];
