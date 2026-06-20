import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

// Resumable uploads are TUS (binary chunks over HTTP) — the byte transfer
// itself isn't a good fit for MCP tool calls, so these tools cover only
// *management* of upload sessions (list / inspect / abort). To actually upload,
// use the SDK's `storage.uploadResumable` or any TUS client against /api/uploads.

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listUploadsTool: McpTool = {
  name: "uploads.list",
  description:
    "List resumable upload sessions in the active workspace. Filter by `status` " +
    "(pending|completed|aborted). The actual byte transfer goes through a TUS " +
    "client / the SDK, not MCP.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "completed", "aborted"] },
      limit: { type: "number" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = new URLSearchParams();
    if (typeof args.status === "string") qs.set("status", args.status);
    if (typeof args.limit === "number") qs.set("limit", String(args.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await ctx.fetchInternal(`/api/uploads${suffix}`);
    return textResult(await readJson<unknown>(res));
  },
};

export const getUploadTool: McpTool = {
  name: "uploads.get",
  description:
    "Fetch a single resumable upload session by id — its declared size, the " +
    "committed offset (resume point), status, and target key.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/uploads/${encodeURIComponent(id)}`);
    return textResult(await readJson<unknown>(res));
  },
};

export const abortUploadTool: McpTool = {
  name: "uploads.abort",
  description:
    "Abort an in-progress resumable upload — discards the staged multipart " +
    "upload and frees the session.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/uploads/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return textResult({ ok: res.ok, status: res.status });
  },
};

export const uploadsTools: McpTool[] = [listUploadsTool, getUploadTool, abortUploadTool];
