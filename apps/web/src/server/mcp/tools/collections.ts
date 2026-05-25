import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const requireSlug = (args: Record<string, unknown>): string => {
  const slug = args.collection;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("VALIDATION: collection is required");
  }
  return slug;
};

const requireId = (args: Record<string, unknown>): string => {
  const id = args.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("VALIDATION: id is required");
  }
  return id;
};

const buildListQuery = (args: Record<string, unknown>): URLSearchParams => {
  const qs = new URLSearchParams();
  if (typeof args.limit === "number") qs.set("limit", String(args.limit));
  if (typeof args.offset === "number") qs.set("offset", String(args.offset));
  if (Array.isArray(args.fields)) {
    qs.set("fields", (args.fields as unknown[]).map(String).join(","));
  } else if (typeof args.fields === "string") {
    qs.set("fields", args.fields);
  }
  if (typeof args.sort === "string") qs.set("sort", args.sort);
  if (args.filter !== undefined && args.filter !== null) {
    qs.set("filter", JSON.stringify(args.filter));
  }
  if (args.meta === true || args.meta === "*") qs.set("meta", "*");
  else if (typeof args.meta === "string") qs.set("meta", args.meta);
  return qs;
};

export const listItems: McpTool = {
  name: "collections.list",
  description:
    "List items from a collection with Directus-style filters, sort, and " +
    "field selection. Returns `{ data, limit, offset, meta? }`. Permission " +
    "DSL filters are applied automatically by the caller's identity.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      filter: {
        type: "object",
        description:
          "Directus-shaped filter (`{field: {_eq: ...}}`, `_and`, `_or`, etc.). " +
          "Omit for an unfiltered listing (still subject to permission DSL).",
      },
      sort: {
        type: "string",
        description: "Comma-separated, `-prefix` for DESC (e.g. `-created_at,name`).",
      },
      fields: {
        type: ["array", "string"],
        description: "Field projection. Array of names or comma-separated string.",
      },
      limit: { type: "number", description: "Max rows (server default applies)." },
      offset: { type: "number", description: "Pagination offset." },
      meta: {
        type: ["boolean", "string"],
        description: "Set true (or `*`) to include `meta.total` in the response.",
      },
    },
    required: ["collection"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const qs = buildListQuery(args);
    const path =
      `/api/items/${encodeURIComponent(slug)}` +
      (qs.toString() ? `?${qs.toString()}` : "");
    const res = await ctx.fetchInternal(path);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const readItem: McpTool = {
  name: "collections.read",
  description: "Read a single item by id from a collection.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      id: { type: "string" },
      fields: { type: ["array", "string"] },
    },
    required: ["collection", "id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const id = requireId(args);
    const qs = new URLSearchParams();
    if (Array.isArray(args.fields)) {
      qs.set("fields", (args.fields as unknown[]).map(String).join(","));
    } else if (typeof args.fields === "string") {
      qs.set("fields", args.fields);
    }
    const path =
      `/api/items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}` +
      (qs.toString() ? `?${qs.toString()}` : "");
    const res = await ctx.fetchInternal(path);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const insertItem: McpTool = {
  name: "collections.insert",
  description:
    "Insert a new item into a collection. Returns the created row. The " +
    "`data` object is validated against the collection's field schema.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      data: { type: "object", description: "Field → value map for the new row." },
    },
    required: ["collection", "data"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const data = args.data;
    if (!data || typeof data !== "object") {
      throw new Error("VALIDATION: data must be an object");
    }
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const updateItem: McpTool = {
  name: "collections.update",
  description:
    "Patch an existing item by id. Only the supplied fields are changed; " +
    "omitted fields are left untouched. Returns the updated row.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      id: { type: "string" },
      data: { type: "object", description: "Partial field → value map." },
    },
    required: ["collection", "id", "data"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const id = requireId(args);
    const data = args.data;
    if (!data || typeof data !== "object") {
      throw new Error("VALIDATION: data must be an object");
    }
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const deleteItem: McpTool = {
  name: "collections.delete",
  description: "Delete an item by id from a collection. Returns `{ ok: true }`.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      id: { type: "string" },
    },
    required: ["collection", "id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const id = requireId(args);
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const collectionsTools: McpTool[] = [
  listItems,
  readItem,
  insertItem,
  updateItem,
  deleteItem,
];
