import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listTemplates: McpTool = {
  name: "templates.list",
  description:
    "List the schema-template catalog — ready-made vertical collection sets " +
    "(blog, ecommerce, crm, …). Each entry shows id, label, category, whether " +
    "it's recommended, how many sample rows it seeds, and its collections. Use " +
    "`templates.apply` with an id to seed one into the active workspace.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/templates`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const applyTemplate: McpTool = {
  name: "templates.apply",
  description:
    "Seed a vertical template's collections (and realistic sample data) into " +
    "the active workspace. Idempotent — collections that already exist are " +
    "skipped. Returns `{ templateId, created, skipped, seeded }`. Requires " +
    "`create` on `system_collections` (admin).",
  inputSchema: {
    type: "object",
    properties: {
      templateId: {
        type: "string",
        description: "Template id from `templates.list` (e.g. \"blog\", \"ecommerce\").",
      },
    },
    required: ["templateId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const templateId = String(args.templateId ?? "");
    if (!templateId) throw new Error("VALIDATION: templateId is required");
    const res = await ctx.fetchInternal(`/api/admin/templates/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      throw new Error(`templates.apply: upstream returned non-JSON (status ${res.status})`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
      isError: !res.ok,
    };
  },
};

export const templatesTools: McpTool[] = [listTemplates, applyTemplate];
