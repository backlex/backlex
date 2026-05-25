import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listRevisions: McpTool = {
  name: "revisions.list",
  description:
    "List historical revisions of a single item in a versioned collection. " +
    "Returns id, action, snapshot, createdAt, and userId per revision. The " +
    "collection must have `versioned: true`.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      itemId: { type: "string" },
    },
    required: ["collection", "itemId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const collection = String(args.collection ?? "");
    const itemId = String(args.itemId ?? "");
    if (!collection || !itemId)
      throw new Error("VALIDATION: collection and itemId are required");
    const res = await ctx.fetchInternal(
      `/api/revisions/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}`,
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const revertRevision: McpTool = {
  name: "revisions.revert",
  description:
    "Roll an item back to a previous revision by revision id. Writes a new " +
    "revision marking the rollback in audit history. Subject to `update` " +
    "permission on the collection.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Revision id, NOT item id." } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/revisions/${encodeURIComponent(id)}/revert`,
      { method: "POST" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const revisionsTools: McpTool[] = [listRevisions, revertRevision];
