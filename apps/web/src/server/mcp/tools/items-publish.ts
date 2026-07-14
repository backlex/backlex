import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

// Publish workflow for versioned collections. Reads already pass `?status`
// through the items query tools; these cover the write side (publish / unpublish
// / schedule), each requiring the `publish` permission on the collection.

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const reqIds = (args: Record<string, unknown>): { collection: string; id: string } => {
  const collection = String(args.collection ?? "");
  const id = String(args.id ?? "");
  if (!collection) throw new Error("VALIDATION: collection is required");
  if (!id) throw new Error("VALIDATION: id is required");
  return { collection, id };
};

export const publishItemTool: McpTool = {
  name: "items.publish",
  description:
    "Publish a versioned-collection item now (sets `_status='published'`). " +
    "Requires the `publish` permission on the collection.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      id: { type: "string", description: "Item id." },
    },
    required: ["collection", "id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { collection, id } = reqIds(args);
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish`,
      { method: "POST" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const unpublishItemTool: McpTool = {
  name: "items.unpublish",
  description:
    "Revert a versioned-collection item to draft (clears any pending schedule). " +
    "Requires the `publish` permission.",
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
    const { collection, id } = reqIds(args);
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish?unpublish=1`,
      { method: "POST" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const archiveItemTool: McpTool = {
  name: "items.archive",
  description:
    "Archive a versioned-collection item (sets `_status='archived'`) — hidden " +
    "from readers like a draft, but a distinct 'pulled from publication' state. " +
    "Leave archived via `items.publish` (→ published) or `items.unpublish` " +
    "(→ draft). Requires the `publish` permission.",
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
    const { collection, id } = reqIds(args);
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish?archive=1`,
      { method: "POST" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const schedulePublishItemTool: McpTool = {
  name: "items.schedule_publish",
  description:
    "Schedule a versioned-collection item to auto-publish at a future time. The " +
    "cron tick flips it to published when due. Pass `publishAt: null` to cancel a " +
    "pending schedule. Requires the `publish` permission.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      id: { type: "string" },
      publishAt: {
        type: ["string", "null"],
        description: "ISO timestamp to publish at, or null to cancel.",
      },
    },
    required: ["collection", "id", "publishAt"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { collection, id } = reqIds(args);
    const publishAt = args.publishAt == null ? null : String(args.publishAt);
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publishAt }),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const scheduleUnpublishItemTool: McpTool = {
  name: "items.schedule_unpublish",
  description:
    "Set an expiry on a versioned-collection item: the cron tick auto-unpublishes " +
    "it back to draft at a future time, preserving its current state until then. " +
    "Pass `unpublishAt: null` to cancel a pending expiry. Requires the `publish` " +
    "permission.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      id: { type: "string" },
      unpublishAt: {
        type: ["string", "null"],
        description: "ISO timestamp to auto-unpublish at, or null to cancel.",
      },
    },
    required: ["collection", "id", "unpublishAt"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { collection, id } = reqIds(args);
    const unpublishAt = args.unpublishAt == null ? null : String(args.unpublishAt);
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unpublishAt }),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const verifyItemTool: McpTool = {
  name: "items.verify",
  description:
    "Check a plaintext against the stored digest of a `hash` field on a row. " +
    "The digest never leaves the server; returns only `{ valid }`. Requires the " +
    "`read` permission; attempts are throttled and audit-logged.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      id: { type: "string", description: "Item id." },
      field: { type: "string", description: "The `hash` field name to check against." },
      value: { type: "string", description: "The plaintext to verify." },
    },
    required: ["collection", "id", "field", "value"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { collection, id } = reqIds(args);
    const field = String(args.field ?? "");
    const value = String(args.value ?? "");
    if (!field) throw new Error("VALIDATION: field is required");
    if (!value) throw new Error("VALIDATION: value is required");
    const res = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/verify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field, value }),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const itemsPublishTools: McpTool[] = [
  publishItemTool,
  unpublishItemTool,
  archiveItemTool,
  schedulePublishItemTool,
  scheduleUnpublishItemTool,
  verifyItemTool,
];
