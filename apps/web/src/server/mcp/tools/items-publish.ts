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

export const itemsPublishTools: McpTool[] = [
  publishItemTool,
  unpublishItemTool,
  schedulePublishItemTool,
];
