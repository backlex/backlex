import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";
import { collectionLink, withLinks } from "./_links";

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
    "Create a new collection — either managed (backlex creates the physical " +
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
          "Array of `{ name, type, required?, unique?, to?, localized? }`. " +
          "Supported types: text, longtext, integer, number, boolean, json, " +
          "timestamp, uuid, relation, relation_many. relation/_many requires `to`. " +
          "`localized: true` stores the value per-locale in the collection's " +
          "translations sidecar (any type except computed/hash); read/write one " +
          "locale with `?locale=xx`, the full map with `?locale=*`.",
      },
      ownerScoped: { type: "boolean" },
      tenantScoped: { type: "boolean" },
      versioned: { type: "boolean" },
      fts: {
        type: "boolean",
        description:
          "Keyword full-text-search index over the fields marked " +
          "`searchable: true` (text/longtext). Powers `collections.search` " +
          "mode `fts` and keyword `?q=` filtering.",
      },
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
    // Link to the collection just created so the agent can inspect it next.
    const slug = String(args.slug ?? "");
    return slug ? withLinks(textResult(body), collectionLink(slug)) : textResult(body);
  },
};

export const updateCollection: McpTool = {
  name: "schema.update_collection",
  description:
    "Patch a collection's metadata or field list. Field changes go through " +
    "the additive applier — columns are added; column removal goes via " +
    "`schema.drop_field`. Enabling `fts` (or changing which fields are " +
    "`searchable`) auto-backfills the full-text index for existing rows — " +
    "the response's `ftsBackfill` reports `{ processed, skipped, total }`.",
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
      fts: {
        type: "boolean",
        description:
          "Keyword full-text-search index over the fields marked " +
          "`searchable: true`. Enabling on an existing collection " +
          "auto-backfills the index for rows already present.",
      },
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

export const dropField: McpTool = {
  name: "schema.drop_field",
  description:
    "Drop a single field (column) from a managed collection. Destructive — " +
    "the column and all its data are removed (`ALTER TABLE … DROP COLUMN`). " +
    "Refused on adopted collections (the source table is never altered) and " +
    "on reserved columns. Returns `{ ok: true, slug, field }`.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string" },
      name: { type: "string", description: "Field (column) name to drop." },
    },
    required: ["slug", "name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = requireSlug(args);
    const name = args.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("VALIDATION: name is required");
    }
    const res = await ctx.fetchInternal(
      `/api/collections/${encodeURIComponent(slug)}/fields/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return withLinks(textResult(body), collectionLink(slug));
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

export const ftsReindex: McpTool = {
  name: "schema.fts_reindex",
  description:
    "Rebuild the collection's full-text-search index for every existing row. " +
    "Rarely needed — `schema.update_collection` auto-backfills when `fts` or " +
    "the `searchable` field set changes; use this as a manual recovery (e.g. " +
    "rows imported around the API). Requires `fts: true` and at least one " +
    "searchable text field. Returns `{ ok, processed, skipped, total }`.",
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
      `/api/collections/${encodeURIComponent(slug)}/fts-reindex`,
      { method: "POST" },
    );
    const body = await readJson<unknown>(res);
    return withLinks(textResult(body), collectionLink(slug));
  },
};

export const rollupsRefresh: McpTool = {
  name: "schema.rollups_refresh",
  description:
    "Restate every rollup column on a collection from the rows it aggregates. " +
    "Rarely needed — ordinary item writes keep rollups in step, and " +
    "`schema.update_collection` auto-backfills when a rollup definition " +
    "changes; use this as a manual recovery after rows were written around " +
    "the write path (a restore, a template seed, a direct SQL edit). " +
    "Idempotent. Returns `{ ok, refreshed }` naming the columns restated.",
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
      `/api/items/${encodeURIComponent(slug)}/rollups/refresh`,
      { method: "POST" },
    );
    const body = await readJson<unknown>(res);
    return withLinks(textResult(body), collectionLink(slug));
  },
};

export const sequencesSync: McpTool = {
  name: "schema.sequences_sync",
  description:
    "Move a collection's sequence (document-number) counters forward to the " +
    "highest number already stored in each column, per reset period. Use " +
    "after a table arrives with numbers already in it — an adopted table, a " +
    "restore, a bulk seed — because otherwise the counter starts at zero and " +
    "the next create reissues a number that is already on a document. " +
    "Counters are only ever moved FORWARD. Idempotent. Returns " +
    "`{ ok, synced }` naming each column, the periods it advanced, and how " +
    "many stored values did not match the field's pattern.",
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
      `/api/items/${encodeURIComponent(slug)}/sequences/sync`,
      { method: "POST" },
    );
    const body = await readJson<unknown>(res);
    return withLinks(textResult(body), collectionLink(slug));
  },
};

export const vectorizeBackfill: McpTool = {
  name: "schema.vectorize_backfill",
  description:
    "Embed every existing row of a vectorize-enabled collection into the " +
    "vector store. Deliberately manual (unlike the FTS auto-backfill): each " +
    "row is one embedding-provider call, so it costs money/quota — confirm " +
    "with the user before running on large collections. Check " +
    "`vector.capabilities` first if unsure the deployment can embed at all. " +
    "Returns `{ ok, processed, skipped, total }`.",
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
      `/api/collections/${encodeURIComponent(slug)}/vectorize`,
      { method: "POST" },
    );
    const body = await readJson<unknown>(res);
    return withLinks(textResult(body), collectionLink(slug));
  },
};

export const schemaAdminTools: McpTool[] = [
  createCollection,
  updateCollection,
  dropField,
  dropCollection,
  ftsReindex,
  rollupsRefresh,
  sequencesSync,
  vectorizeBackfill,
];
