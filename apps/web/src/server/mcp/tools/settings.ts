import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const getSettings: McpTool = {
  name: "settings.get",
  description:
    "Read workspace-level settings (default locale, timezone, feature flags, " +
    "branding, etc.). Returns the full app_settings row.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/settings`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const patchSettings: McpTool = {
  name: "settings.update",
  description:
    "Patch workspace settings. Send only the keys you want to change; " +
    "omitted keys retain their current value. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      i18nDefaultLocale: { type: "string" },
      timezone: { type: "string" },
      brandName: { type: "string" },
      flags: { type: "object" },
    },
    additionalProperties: true,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const settingsTools: McpTool[] = [getSettings, patchSettings];
