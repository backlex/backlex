import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * The OAuth client registry over MCP.
 *
 * An agent operating this server needs two things the protocol itself does not
 * give it: a list of who has been let in (including the clients that let
 * themselves in), and a way to take a grant back completely rather than only
 * removing the consent row.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/oauth-clients";

export const listOAuthClientsTool: McpTool = {
  name: "oauth.clients",
  description:
    "List the OAuth clients this instance's authorization server knows, and whether open dynamic " +
    "registration is currently accepted. `dynamic: true` marks a client that registered itself — " +
    "nobody vetted those. Client secrets are never included.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_a, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(BASE))),
};

export const registerOAuthClientTool: McpTool = {
  name: "oauth.register",
  description:
    "Register a client. A `confidential` client's secret is returned ONCE — surface it immediately. " +
    "A `public` client gets none: PKCE protects it, and a secret shipped in a browser or a CLI is " +
    "not a secret. Redirect URIs must be https, or http on loopback for a native app.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      redirectUrls: { type: "array", items: { type: "string" } },
      type: { type: "string", enum: ["public", "confidential"] },
    },
    required: ["name", "redirectUrls"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(BASE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        }),
      ),
    ),
};

export const setOAuthClientDisabledTool: McpTool = {
  name: "oauth.set_disabled",
  description:
    "Enable or disable a client. Disabling stops it immediately and KEEPS its history — which " +
    "tokens it holds, who consented, when. Prefer it to deleting for a client that misbehaved: " +
    "the history is the evidence.",
  inputSchema: {
    type: "object",
    properties: { clientId: { type: "string" }, disabled: { type: "boolean" } },
    required: ["clientId", "disabled"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { clientId, ...body } = args as Record<string, unknown>;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(String(clientId))}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  },
};

export const listOAuthGrantsTool: McpTool = {
  name: "oauth.grants",
  description: "Who has authorised which client, and for what scopes.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      clientId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 500 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const q = new URLSearchParams();
    for (const k of ["userId", "clientId", "limit"] as const) {
      if (args[k] !== undefined) q.set(k, String(args[k]));
    }
    const qs = q.toString();
    return textResult(
      await readJson<unknown>(await ctx.fetchInternal(`${BASE}/grants${qs ? `?${qs}` : ""}`)),
    );
  },
};

export const revokeOAuthGrantTool: McpTool = {
  name: "oauth.revoke_grant",
  description:
    "Take a grant back. Deletes the consent AND every token issued under it — removing only the " +
    "consent would leave the access token working until it expired and the refresh token minting " +
    "more.",
  inputSchema: {
    type: "object",
    properties: { clientId: { type: "string" }, userId: { type: "string" } },
    required: ["clientId", "userId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/grants/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        }),
      ),
    ),
};

export const oauthTools: McpTool[] = [
  listOAuthClientsTool,
  registerOAuthClientTool,
  setOAuthClientDisabledTool,
  listOAuthGrantsTool,
  revokeOAuthGrantTool,
];
