import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const scopeQs = (args: Record<string, unknown>) =>
  args.scope === "global" ? "?scope=global" : "";

export const listFlagsTool: McpTool = {
  name: "flags.list",
  description:
    "List feature-flag definitions for the active workspace (global defaults + " +
    "per-tenant overrides), including enabled state, value, and targeting rules.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/feature-flags`);
    return textResult(await readJson<unknown>(res));
  },
};

export const setFlagTool: McpTool = {
  name: "flags.set",
  description:
    "Create or update a feature flag. `enabled` toggles it; `value` is the remote-" +
    "config payload returned when on; `rules` is optional targeting " +
    "`{ condition?: <permission DSL>, rollout?: 0-100 }`. Set `scope:\"global\"` to " +
    "edit the cross-workspace default instead of the active workspace.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      enabled: { type: "boolean" },
      value: {},
      rules: { type: ["object", "null"] },
      description: { type: ["string", "null"] },
      scope: { type: "string", enum: ["global", "tenant"] },
    },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const key = String(args.key ?? "");
    if (!key) throw new Error("VALIDATION: key is required");
    const { key: _k, scope: _s, ...body } = args;
    const res = await ctx.fetchInternal(
      `/api/admin/feature-flags/${encodeURIComponent(key)}${scopeQs(args)}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const removeFlagTool: McpTool = {
  name: "flags.remove",
  description: "Delete a feature flag (set `scope:\"global\"` for the default row).",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      scope: { type: "string", enum: ["global", "tenant"] },
    },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const key = String(args.key ?? "");
    if (!key) throw new Error("VALIDATION: key is required");
    const res = await ctx.fetchInternal(
      `/api/admin/feature-flags/${encodeURIComponent(key)}${scopeQs(args)}`,
      { method: "DELETE" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const featureFlagsTools: McpTool[] = [listFlagsTool, setFlagTool, removeFlagTool];
