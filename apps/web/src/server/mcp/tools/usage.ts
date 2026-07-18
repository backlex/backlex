import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const usageOverview: McpTool = {
  name: "usage.overview",
  // "overview" isn't a recognized read verb — pin the kind so read-only keys
  // can still inspect usage.
  kind: "read",
  description:
    "Workspace usage overview (admin-only): per-day request/error series, " +
    "per-API-key monthly totals, storage/row gauges, effective usage limits " +
    "(env-pinned fields marked), and which dimensions are over budget.",
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Series window in days (default 30, max 90).",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const days = Number(args.days ?? 30);
    const qs = Number.isFinite(days) ? `?days=${Math.min(90, Math.max(1, Math.floor(days)))}` : "";
    const res = await ctx.fetchInternal(`/api/admin/usage/overview${qs}`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const usageSetLimits: McpTool = {
  name: "usage.set_limits",
  description:
    "Set the workspace's admin-editable usage limits. `mode` is off | soft | " +
    "hard; each max is a positive integer or null (unlimited). Fields pinned " +
    "by USAGE_LIMIT_* env vars still win at enforcement time.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["off", "soft", "hard"] },
      maxRequestsPerMonth: { type: ["number", "null"] },
      maxStorageBytes: { type: ["number", "null"] },
      maxDbRows: { type: ["number", "null"] },
    },
    required: ["mode"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/usage/limits`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: args.mode,
        maxRequestsPerMonth: args.maxRequestsPerMonth ?? null,
        maxStorageBytes: args.maxStorageBytes ?? null,
        maxDbRows: args.maxDbRows ?? null,
      }),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const usageTools: McpTool[] = [usageOverview, usageSetLimits];
