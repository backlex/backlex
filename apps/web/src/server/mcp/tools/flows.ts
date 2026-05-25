import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listFlows: McpTool = {
  name: "flows.list",
  description:
    "List visual workflows in the active workspace. Each row shows id, " +
    "name, trigger, and active state. Use `flows.invoke` to run one by id.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/flows`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const getFlow: McpTool = {
  name: "flows.get",
  description: "Fetch a single flow's full definition (nodes + edges) by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/flows/${encodeURIComponent(id)}`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const invokeFlow: McpTool = {
  name: "flows.invoke",
  description:
    "Run a flow synchronously. The `input` object is passed as the flow's " +
    "trigger payload. Returns `{ ok, output?, error?, durationMs, steps }`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      input: { type: "object", description: "Payload passed to the flow trigger." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const input =
      args.input && typeof args.input === "object" ? args.input : {};
    const res = await ctx.fetchInternal(
      `/api/flows/${encodeURIComponent(id)}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    const body = (await res.json().catch(() => null)) as
      | ({ ok?: boolean } & Record<string, unknown>)
      | null;
    if (!body) {
      throw new Error(`flows.invoke: upstream returned non-JSON (status ${res.status})`);
    }
    const isError = !res.ok || body.ok === false;
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
      isError,
    };
  },
};

export const flowsTools: McpTool[] = [listFlows, getFlow, invokeFlow];
