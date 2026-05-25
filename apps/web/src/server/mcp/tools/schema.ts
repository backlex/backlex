import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

interface CollectionMeta {
  id: string;
  slug: string;
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  fields: Array<{
    name: string;
    type: string;
    required?: boolean;
    unique?: boolean;
    to?: string;
  }>;
  ownerScoped?: boolean;
  tenantScoped?: boolean;
  versioned?: boolean;
  adopted?: boolean;
  vectorize?: boolean;
  physicalTable?: string;
}

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listCollections: McpTool = {
  name: "schema.list_collections",
  description:
    "List every collection visible to the active workspace. Returns slug, " +
    "singular/plural display names, and a short summary (field count, " +
    "owner-scoped flag, adopted flag). Use this first to discover what " +
    "collections exist before calling other tools.",
  inputSchema: {
    type: "object",
    properties: {
      includeArchived: {
        type: "boolean",
        description: "Include archived (soft-deleted) adopted collections.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const includeArchived = args.includeArchived === true;
    const path = includeArchived
      ? "/api/collections?include_archived=true"
      : "/api/collections";
    const res = await ctx.fetchInternal(path);
    const body = await readJson<{ data: CollectionMeta[] }>(res);
    const summary = body.data.map((c) => ({
      slug: c.slug,
      singular: c.singular ?? null,
      plural: c.plural ?? null,
      note: c.note ?? null,
      fieldCount: Array.isArray(c.fields) ? c.fields.length : 0,
      ownerScoped: Boolean(c.ownerScoped),
      tenantScoped: c.tenantScoped !== false,
      adopted: Boolean(c.adopted),
      versioned: Boolean(c.versioned),
      vectorize: Boolean(c.vectorize),
    }));
    return textResult({ collections: summary });
  },
};

export const describeCollection: McpTool = {
  name: "schema.describe_collection",
  description:
    "Return the full field definition for a single collection — field " +
    "names, types, relations, validation rules, default sort. Use this " +
    "to learn the shape before crafting filter / insert / update calls.",
  inputSchema: {
    type: "object",
    properties: {
      collection: {
        type: "string",
        description: "Collection slug (e.g. `products`, `users`).",
      },
    },
    required: ["collection"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = String(args.collection ?? "");
    if (!slug) throw new Error("VALIDATION: collection is required");
    const res = await ctx.fetchInternal(
      `/api/collections/${encodeURIComponent(slug)}`,
    );
    const body = await readJson<{ data: CollectionMeta }>(res);
    return textResult({
      slug: body.data.slug,
      singular: body.data.singular ?? null,
      plural: body.data.plural ?? null,
      note: body.data.note ?? null,
      ownerScoped: Boolean(body.data.ownerScoped),
      tenantScoped: body.data.tenantScoped !== false,
      adopted: Boolean(body.data.adopted),
      versioned: Boolean(body.data.versioned),
      vectorize: Boolean(body.data.vectorize),
      fields: body.data.fields,
    });
  },
};

export const schemaTools: McpTool[] = [listCollections, describeCollection];
