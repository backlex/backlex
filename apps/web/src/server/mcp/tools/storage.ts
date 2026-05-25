import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const requireKey = (args: Record<string, unknown>): string => {
  const key = args.key;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("VALIDATION: key is required");
  }
  return key;
};

export const listFiles: McpTool = {
  name: "storage.list",
  description:
    "List files in the active workspace. Supports prefix, folder, and " +
    "substring search filters. Returns `{ data, meta: { total, limit, offset } }`.",
  inputSchema: {
    type: "object",
    properties: {
      prefix: { type: "string", description: "Logical key prefix (e.g. `photos/2024/`)." },
      folderId: { type: "string", description: "Folder UUID, or `__root__` for files with no folder." },
      search: { type: "string", description: "Substring match against the file key." },
      limit: { type: "number" },
      offset: { type: "number" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = new URLSearchParams();
    if (typeof args.prefix === "string") qs.set("prefix", args.prefix);
    if (typeof args.folderId === "string") qs.set("folderId", args.folderId);
    if (typeof args.search === "string") qs.set("search", args.search);
    if (typeof args.limit === "number") qs.set("limit", String(args.limit));
    if (typeof args.offset === "number") qs.set("offset", String(args.offset));
    // Storage list is mounted at `/api/storage` (no trailing slash) — Hono
    // matches `/` inside an `app.route("/api/storage", …)` sub-app to the
    // bare mount path. A trailing slash would fall through to the
    // `:key{.+}` catch-all and 404 on an empty key.
    const path = `/api/storage` + (qs.toString() ? `?${qs.toString()}` : "");
    const res = await ctx.fetchInternal(path);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const getFile: McpTool = {
  name: "storage.get",
  description:
    "Fetch a file's bytes by logical key. Small text files (≤ 256 KB) are " +
    "returned inline as UTF-8 text; binary or large files are returned as a " +
    "base64 resource. Use `storage.list` first to discover keys.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Logical key (e.g. `photos/2024/spring/beach.jpg`)." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const key = requireKey(args);
    const res = await ctx.fetchInternal(
      `/api/storage/${key.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`storage.get failed (status ${res.status}): ${text.slice(0, 200)}`);
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const buf = new Uint8Array(await res.arrayBuffer());
    // Heuristic: small text-ish responses go inline as text; everything else
    // surfaces as a base64 resource the caller can decode. The 256 KB cap
    // keeps Worker memory bounded and avoids overwhelming the MCP client.
    const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-ndjson))/i;
    const MAX_INLINE = 256 * 1024;
    if (TEXTUAL.test(contentType) && buf.byteLength <= MAX_INLINE) {
      const text = new TextDecoder().decode(buf);
      return {
        content: [{ type: "text", text }],
        structuredContent: { key, contentType, size: buf.byteLength },
      };
    }
    let binary = "";
    for (let i = 0; i < buf.byteLength; i++) binary += String.fromCharCode(buf[i]!);
    const base64 = btoa(binary);
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: `workeros://storage/${key}`,
            mimeType: contentType,
            text: base64,
          },
        },
      ],
      structuredContent: { key, contentType, size: buf.byteLength, encoding: "base64" },
    };
  },
};

export const uploadFile: McpTool = {
  name: "storage.upload",
  description:
    "Upload a file to the active workspace's storage. Provide `text` for " +
    "UTF-8 content or `base64` for binary. Returns the stored file's " +
    "metadata (size, contentType, key).",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Logical key (e.g. `notes/2026/today.md`)." },
      text: { type: "string", description: "UTF-8 string content." },
      base64: { type: "string", description: "Base64-encoded binary content." },
      contentType: { type: "string", description: "Override the content-type header." },
      folderId: {
        type: "string",
        description: "Pin to a folder UUID, or `__root__` for the root. Defaults to auto-derive from key path.",
      },
    },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const key = requireKey(args);
    let body: BodyInit;
    let contentType: string;
    if (typeof args.text === "string") {
      body = args.text;
      contentType = typeof args.contentType === "string" ? args.contentType : "text/plain; charset=utf-8";
    } else if (typeof args.base64 === "string") {
      const bin = atob(args.base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      body = buf;
      contentType = typeof args.contentType === "string" ? args.contentType : "application/octet-stream";
    } else {
      throw new Error("VALIDATION: one of `text` or `base64` is required");
    }
    const qs = new URLSearchParams();
    if (typeof args.folderId === "string") qs.set("folderId", args.folderId);
    const path =
      `/api/storage/${key.split("/").map(encodeURIComponent).join("/")}` +
      (qs.toString() ? `?${qs.toString()}` : "");
    const res = await ctx.fetchInternal(path, {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
    });
    const parsed = await readJson<unknown>(res);
    return textResult(parsed);
  },
};

export const deleteFile: McpTool = {
  name: "storage.delete",
  description: "Delete a file by logical key. Returns `{ ok: true }`.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
    },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const key = requireKey(args);
    const res = await ctx.fetchInternal(
      `/api/storage/${key.split("/").map(encodeURIComponent).join("/")}`,
      { method: "DELETE" },
    );
    const parsed = await readJson<unknown>(res);
    return textResult(parsed);
  },
};

export const storageTools: McpTool[] = [listFiles, getFile, uploadFile, deleteFile];
