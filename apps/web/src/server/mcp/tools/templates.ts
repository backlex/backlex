import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const passthrough = async (res: Response, what: string): Promise<ToolResult> => {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    throw new Error(`${what}: upstream returned non-JSON (status ${res.status})`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: !res.ok,
  };
};

export const listTemplates: McpTool = {
  name: "templates.list",
  description:
    "List the schema-template catalog — ready-made vertical collection sets " +
    "(blog, ecommerce, crm, …). Each entry shows id, label, category, whether " +
    "it's recommended, how many sample rows it seeds, its admin group headers, " +
    "bundled roles/dashboards, and its collections. Use `templates.apply` with " +
    "an id to seed one into the active workspace.",
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
    "Seed a vertical template's collections (grouped, with realistic sample " +
    "data and any bundled roles/dashboards) into the active workspace. Pass a " +
    "catalog `templateId` OR an inline `template` object (the " +
    "`templates.extract` shape) to apply a custom schema. Idempotent — " +
    "collections that already exist are skipped. Returns `{ templateId, " +
    "created, skipped, seeded, roles, dashboards }`. Requires `create` on " +
    "`system_collections` (admin).",
  inputSchema: {
    type: "object",
    properties: {
      templateId: {
        type: "string",
        description: "Template id from `templates.list` (e.g. \"blog\", \"ecommerce\").",
      },
      template: {
        type: "object",
        description:
          "Inline custom template — `{ label?, description?, groups?, collections: [...] }`, " +
          "the same shape `templates.extract` returns.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const templateId = typeof args.templateId === "string" ? args.templateId : "";
    const template = args.template;
    if (!templateId && !template) {
      throw new Error("VALIDATION: pass templateId or template");
    }
    const res = await ctx.fetchInternal(`/api/admin/templates/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(templateId ? { templateId } : { template }),
    });
    return passthrough(res, "templates.apply");
  },
};

export const clearTemplateSamples: McpTool = {
  name: "templates.clearSamples",
  // The kind heuristic reads the leading token ("clearSamples") as a write —
  // this bulk-deletes rows, so pin the destructive classification explicitly.
  kind: "destruct",
  description:
    "Delete every sample row a template apply seeded (tracked in the seed " +
    "manifest) — rows the user created are never touched. Returns " +
    "`{ removed, collections }` (admin).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/templates/clear-samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    return passthrough(res, "templates.clearSamples");
  },
};

export const extractTemplate: McpTool = {
  name: "templates.extract",
  // Pure read — the verb heuristic would otherwise classify it as a write.
  kind: "read",
  description:
    "Export the workspace's managed collections as a reusable schema template " +
    "(collections in dependency order + saved admin group headers; no sample " +
    "data). Optionally narrow with `collections`. Feed the result to " +
    "`templates.apply` on another workspace (admin).",
  inputSchema: {
    type: "object",
    properties: {
      collections: {
        type: "array",
        items: { type: "string" },
        description: "Only export these collection slugs (default: all managed collections).",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slugs = Array.isArray(args.collections)
      ? (args.collections as unknown[]).map(String).filter(Boolean)
      : [];
    const qs = slugs.length ? `?collections=${encodeURIComponent(slugs.join(","))}` : "";
    const res = await ctx.fetchInternal(`/api/admin/templates/extract${qs}`);
    return passthrough(res, "templates.extract");
  },
};

export const templatesTools: McpTool[] = [
  listTemplates,
  applyTemplate,
  clearTemplateSamples,
  extractTemplate,
];
