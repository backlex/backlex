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
        body: JSON.stringify({ message }),
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

export const agentsTools: McpTool[] = [listAgents, getAgent, runAgent];
