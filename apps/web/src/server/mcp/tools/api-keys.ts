import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listApiKeys: McpTool = {
  name: "apikeys.list",
  description:
    "List personal access keys (PAKs) owned by the active user. Returns " +
    "id, prefix, name, role binding, last-used timestamp, and expiry — but " +
    "never the secret (only the create endpoint returns that, once).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/api-keys`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const createApiKey: McpTool = {
  name: "apikeys.create",
  description:
    "Create a personal access key (PAK). The full `pak_<prefix>_<secret>` " +
    "is returned ONCE in `data.secret` — store it immediately. Optional " +
    "`roleId` scopes the key to a single role (it can never widen its " +
    "owner's access); optional `expiresAt` is an ISO timestamp.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Free-form label (auto-generated if omitted)." },
      roleId: { type: "string" },
      expiresAt: { type: "string", description: "ISO-8601 expiry timestamp." },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const revokeApiKey: McpTool = {
  name: "apikeys.revoke",
  description:
    "Revoke a PAK by id. After this, subsequent `Authorization: Bearer pak_…` " +
    "requests with that key 401 immediately.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/api-keys/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const apiKeysTools: McpTool[] = [listApiKeys, createApiKey, revokeApiKey];
