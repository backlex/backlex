import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const requireSlug = (args: Record<string, unknown>): string => {
  const slug = args.slug ?? args.collection;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("VALIDATION: slug is required");
  }
  return slug;
};

export const createCollection: McpTool = {
  name: "schema.create_collection",
  description:
    "Create a new collection — either managed (workeros creates the physical " +
    "table) or adopted (existing table). Field schema follows the same shape " +
    "as the admin UI: `{ name, type, required?, unique?, to? }`. Returns the " +
    "created collection metadata. Requires `create` on `system_collections`.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "snake_case identifier (e.g. `products`)." },
      singular: { type: "string" },
      plural: { type: "string" },
      note: { type: "string" },
      fields: {
        type: "array",
        description:
          "Array of `{ name, type, required?, unique?, to? }`. " +
          "Supported types: text, longtext, integer, number, boolean, json, " +
          "timestamp, uuid, relation, relation_many. relation/_many requires `to`.",
      },
      ownerScoped: { type: "boolean" },
      tenantScoped: { type: "boolean" },
      versioned: { type: "boolean" },
      vectorize: { type: "boolean" },
      vectorizeModel: { type: "string" },
      defaultSort: { type: "string" },
      adopted: { type: "boolean", description: "True to register an existing table without DDL." },
      physicalTable: { type: "string", description: "Custom table name; required when adopted." },
    },
    required: ["slug", "fields"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const updateCollection: McpTool = {
  name: "schema.update_collection",
  description:
    "Patch a collection's metadata or field list. Field changes go through " +
    "the additive applier — columns are added; removal goes via " +
    "`schema.drop_field` (not exposed yet, use the REST endpoint).",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string" },
      singular: { type: "string" },
      plural: { type: "string" },
      note: { type: "string" },
      fields: { type: "array" },
      ownerScoped: { type: "boolean" },
      versioned: { type: "boolean" },
      vectorize: { type: "boolean" },
      vectorizeModel: { type: "string" },
      defaultSort: { type: "string" },
    },
    required: ["slug"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const { slug: _slug, ...patch } = args as Record<string, unknown> & { slug?: string };
    const res = await ctx.fetchInternal(
      `/api/collections/${encodeURIComponent(slug)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const dropCollection: McpTool = {
  name: "schema.drop_collection",
  description:
    "Delete a collection. Managed collections also drop the physical table " +
    "(destructive — data is gone); adopted collections are soft-archived " +
    "(the source table is untouched, `schema.restore_collection` would bring " +
    "it back). Returns `{ ok: true, archived: <bool> }`.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string" },
    },
    required: ["slug"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const res = await ctx.fetchInternal(
      `/api/collections/${encodeURIComponent(slug)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const schemaAdminTools: McpTool[] = [
  createCollection,
  updateCollection,
  dropCollection,
];
