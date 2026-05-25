import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listTenants: McpTool = {
  name: "tenants.list",
  description:
    "List every tenant (workspace) the active user is a member of, plus " +
    "the active tenant marker. Use before `tenants.switch` to find ids.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/tenants`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const switchTenant: McpTool = {
  name: "tenants.switch",
  description:
    "Switch the active tenant for subsequent MCP calls. The change is " +
    "persisted on the user's profile and applies to every workeros surface " +
    "(REST, GraphQL, MCP) until switched again.",
  inputSchema: {
    type: "object",
    properties: { tenantId: { type: "string" } },
    required: ["tenantId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const tenantId = String(args.tenantId ?? "");
    if (!tenantId) throw new Error("VALIDATION: tenantId is required");
    const res = await ctx.fetchInternal(`/api/tenants/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const tenantsTools: McpTool[] = [listTenants, switchTenant];
