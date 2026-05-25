import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listComments: McpTool = {
  name: "comments.list",
  description:
    "List comments attached to a record. Pass `collection` + `itemId` to " +
    "scope to one record, or omit both to get every recent comment in the " +
    "workspace (admin debugging).",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      itemId: { type: "string" },
      limit: { type: "number" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = new URLSearchParams();
    for (const k of ["collection", "itemId"]) {
      const v = args[k];
      if (typeof v === "string" && v.length > 0) qs.set(k, v);
    }
    if (typeof args.limit === "number") qs.set("limit", String(args.limit));
    const path = `/api/comments` + (qs.toString() ? `?${qs.toString()}` : "");
    const res = await ctx.fetchInternal(path);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const postComment: McpTool = {
  name: "comments.post",
  description: "Post a new comment attached to a record. Returns the created row.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      itemId: { type: "string" },
      body: { type: "string", description: "Comment text (Markdown allowed)." },
    },
    required: ["collection", "itemId", "body"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const deleteComment: McpTool = {
  name: "comments.delete",
  description: "Delete a comment by id. Subject to the comment's own permissions.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/comments/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const commentsTools: McpTool[] = [listComments, postComment, deleteComment];
