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
  if (typeof args.locale === "string") qs.set("locale", args.locale);
  return qs;
};

export const listItems: McpTool = {
  name: "collections.list",
  description:
    "List items from a collection with operator-style filters, sort, and " +
    "field selection. Returns `{ data, limit, offset, meta? }`. Permission " +
    "DSL filters are applied automatically by the caller's identity.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      filter: {
        type: "object",
        description:
          "operator-style filter (`{field: {_eq: ...}}`, `_and`, `_or`, etc.). " +
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
      locale: {
        type: "string",
        description:
          "Collapse `localized` fields to one locale (with default " +
          "fallback), or `*` for the full `{locale: value}` map.",
      },
    },
    required: ["collection"],
    additionalProperties: false,
  },
  // Envelope shape is fixed; the rows in `data` are arbitrary collection records.
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      limit: { type: "integer" },
      offset: { type: "integer" },
      meta: { type: "object" },
    },
    required: ["data"],
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
      locale: {
        type: "string",
        description:
          "Collapse `localized` fields to one locale (with default " +
          "fallback), or `*` for the full `{locale: value}` map.",
      },
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
    if (typeof args.locale === "string") qs.set("locale", args.locale);
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
      locale: {
        type: "string",
        description:
          "Write a single locale of every `localized` field (values are then the " +
          "native per-locale value); omit to send full `{locale: value}` maps.",
      },
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
    const localeQs = typeof args.locale === "string" ? `?locale=${encodeURIComponent(args.locale)}` : "";
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}${localeQs}`,
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
      locale: {
        type: "string",
        description:
          "Upsert a single locale of the `localized` fields in `data` without " +
          "disturbing the others; omit to send full `{locale: value}` maps.",
      },
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
    const localeQs = typeof args.locale === "string" ? `?locale=${encodeURIComponent(args.locale)}` : "";
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}${localeQs}`,
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

export const aggregateItems: McpTool = {
  name: "collections.aggregate",
  // Read: an aggregation query, no mutation. The name verb ("aggregate") isn't a
  // read verb, so mark it explicitly or the read-only guard would block it.
  kind: "read",
  description:
    "Aggregate a collection: count / sum / avg / min / max over a numeric " +
    "field, optionally grouped by a column. Use this for analytics questions " +
    "(\"top customers by total spent\", \"orders per status\", \"revenue last " +
    "month\") that collections.list CANNOT answer — list has no grouping or " +
    "sums. Returns `{ data: [{ value }] }` (scalar) or `{ data: [{ label, " +
    "value }, …] }` (grouped, ordered by value desc). Single-table only — no " +
    "relation traversal; `field` (for sum/avg/min/max) and `groupBy` must be " +
    "plain columns of the collection.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      agg: {
        type: "string",
        enum: ["count", "sum", "avg", "min", "max"],
        description: "Aggregate function. `count` ignores `field`.",
      },
      field: {
        type: "string",
        description:
          "Numeric column to aggregate (required for sum/avg/min/max).",
      },
      groupBy: {
        type: "string",
        description:
          "Column to group by — each distinct value becomes a `{label, value}` row.",
      },
      filter: {
        type: "object",
        description:
          "Same filter grammar as collections.list (applied before aggregation).",
      },
      limit: {
        type: "number",
        description: "Max grouped rows (1-200, default 50). Ignored when ungrouped.",
      },
    },
    required: ["collection", "agg"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          // `{ value }` ungrouped, or `{ label, value }` when grouped.
          properties: { value: { type: "number" }, label: {} },
          required: ["value"],
        },
      },
    },
    required: ["data"],
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const { collection: _c, ...body } = args;
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}/aggregate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const out = await readJson<unknown>(res);
    return textResult(out);
  },
};

export const searchItems: McpTool = {
  name: "collections.search",
  // Read: a relevance query, no mutation. The verb ("search") isn't one of the
  // read-only guard's recognised prefixes, so mark it explicitly.
  kind: "read",
  description:
    "Relevance search over a collection. `mode: \"fts\"` ranks by keyword " +
    "(full-text index), `\"vector\"` by semantic similarity (embeddings), " +
    "`\"hybrid\"` fuses both with Reciprocal Rank Fusion. Prefer this over " +
    "collections.list when the user asks a 'find the most relevant…' / " +
    "'search for…' question — list only does exact filters, not ranking. The " +
    "collection must have the matching capability enabled (`fts` and/or " +
    "`vectorize`); omit `mode` to let the server pick (hybrid when both are " +
    "on). Returns `{ data: [...rows], mode, limit }`, best-first, with the " +
    "caller's read permission + tenant scope enforced.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      q: { type: "string", description: "The search query string." },
      mode: {
        type: "string",
        enum: ["fts", "vector", "hybrid"],
        description:
          "Ranking backend. Omit to auto-pick (hybrid when both FTS and vector are enabled).",
      },
      limit: {
        type: "number",
        description: "Max rows (1-100, default 20).",
      },
      locale: {
        type: "string",
        description: "Collapse localized fields to one locale, or `*` for the full map.",
      },
      passages: {
        type: "boolean",
        description:
          "Attach `_passages` to each row — the chunks of it that actually matched, best-first, each with its own score. Set this when you are about to quote or summarise: a long row is stored as several passages and this hands you the relevant one instead of the whole document, which is both more accurate and far fewer tokens. Vector/hybrid only; silently absent when the caller's permission carries a field allow-list.",
      },
    },
    required: ["collection", "q"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      mode: { type: "string", enum: ["fts", "vector", "hybrid"] },
      limit: { type: "number" },
    },
    required: ["data", "mode", "limit"],
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const { collection: _c, ...body } = args;
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const out = await readJson<unknown>(res);
    return textResult(out);
  },
};

export const changesItems: McpTool = {
  name: "collections.changes",
  // Read: drains an incremental feed, mutates nothing.
  kind: "read",
  description:
    "One page of a collection's incremental changefeed — rows whose " +
    "`updatedAt` is past the `since` cursor, keyset-paginated so nothing is " +
    "skipped or repeated. Use this to answer 'what changed since…' or to " +
    "replicate a collection locally; use collections.list for a plain " +
    "snapshot. Soft-deleted rows appear as tombstones (`_deleted: true`) so " +
    "deletions are observable. Pass `shape` (a flat filter, same grammar as " +
    "collections.list's `filter`, but no relation hops) to follow only a " +
    "subset — rows that LEFT the subset come back as `{ id, _shape_exit: " +
    "true }`. Omit `since` for a full initial pull; feed the returned " +
    "`cursor` back as `since` and repeat while `hasMore` is true.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      since: {
        type: "string",
        description: "Opaque cursor from a prior call. Omit for a full initial pull.",
      },
      limit: { type: "number", description: "Rows per page (1-500, default 100)." },
      shape: {
        type: "object",
        description:
          "Flat filter naming the subset to follow, e.g. `{\"status\":{\"_eq\":\"open\"}}`. Relation hops are rejected.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Narrow the columns returned. `id` and `updatedAt` always come along.",
      },
    },
    required: ["collection"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      cursor: { type: ["string", "null"] },
      hasMore: { type: "boolean" },
      shape: { type: "string" },
    },
    required: ["data", "cursor", "hasMore"],
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const qs = new URLSearchParams();
    if (typeof args.since === "string") qs.set("since", args.since);
    if (typeof args.limit === "number") qs.set("limit", String(args.limit));
    if (args.shape !== undefined && args.shape !== null) qs.set("shape", JSON.stringify(args.shape));
    if (Array.isArray(args.fields)) {
      qs.set("fields", (args.fields as unknown[]).map(String).join(","));
    }
    const q = qs.toString();
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}/changes${q ? `?${q}` : ""}`,
    );
    const out = await readJson<unknown>(res);
    return textResult(out);
  },
};

export const collectionsTools: McpTool[] = [
  listItems,
  readItem,
  aggregateItems,
  searchItems,
  changesItems,
  insertItem,
  updateItem,
  deleteItem,
];
