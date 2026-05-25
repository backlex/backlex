import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listSharedLinks: McpTool = {
  name: "shared_links.list",
  description:
    "List record-share links for the active workspace. Each link grants " +
    "public, unauthenticated read access to a single record until revoked " +
    "or expired.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/shared-links`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const createSharedLink: McpTool = {
  name: "shared_links.create",
  description:
    "Mint a new public share link for a record. Returns `{ token, url }` " +
    "— the URL is the part to send out; `token` can be revoked later.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      itemId: { type: "string" },
      expiresAt: { type: "string", description: "ISO-8601 expiry; omit for non-expiring." },
      fields: { type: "array", description: "Optional field allow-list to narrow what the link exposes." },
    },
    required: ["collection", "itemId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/shared-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const revokeSharedLink: McpTool = {
  name: "shared_links.revoke",
  description: "Revoke a share link by id; the public URL stops resolving immediately.",
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
      `/api/shared-links/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const sharedLinksTools: McpTool[] = [
  listSharedLinks,
  createSharedLink,
  revokeSharedLink,
];
