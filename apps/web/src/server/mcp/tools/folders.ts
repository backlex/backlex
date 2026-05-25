import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listFolders: McpTool = {
  name: "folders.list",
  description: "List storage folders for the active workspace (admin/UI grouping).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/folders`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const createFolder: McpTool = {
  name: "folders.create",
  description: "Create a new storage folder.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const deleteFolder: McpTool = {
  name: "folders.delete",
  description: "Delete a storage folder by id. Files inside are NOT deleted; they become root-level.",
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
      `/api/folders/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const foldersTools: McpTool[] = [listFolders, createFolder, deleteFolder];
