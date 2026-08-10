import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Signing keys over MCP.
 *
 * The order matters more than any individual tool, and the descriptions say so:
 * generate → wait for the JWKS to propagate → promote. An agent that promoted
 * immediately would mint tokens nobody could verify until their cache expired.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/signing-keys";
const none = { type: "object", properties: {}, additionalProperties: false } as const;
const byId = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
} as const;

const post = async (ctx: any, path: string, body?: unknown) =>
  textResult(
    await readJson<unknown>(
      await ctx.fetchInternal(path, {
        method: "POST",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
    ),
  );

export const listSigningKeysTool: McpTool = {
  name: "signing_keys.list",
  description:
    "List this instance's JWT signing keys and their states — `standby` (published, signing " +
    "nothing), `in_use` (signs new tokens), `previously_used` (still verifies its own tokens), " +
    "`revoked` (out of the JWKS). Private halves are never included.",
  inputSchema: none,
  handler: async (_a, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(BASE))),
};

export const generateSigningKeyTool: McpTool = {
  name: "signing_keys.generate",
  description:
    "Generate a key pair. It is created in `standby` — published in the JWKS, signing nothing — " +
    "and that order is not optional: verifiers cache the JWKS, so promoting immediately would " +
    "mint tokens nobody could verify until their cache expired. Promote it afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      alg: { type: "string", enum: ["ES256", "RS256"] },
      note: { type: "string" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => post(ctx, BASE, args),
};

export const promoteSigningKeyTool: McpTool = {
  name: "signing_keys.promote",
  description:
    "Sign new tokens with this key. The incumbent becomes `previously_used` in the same operation " +
    "and keeps verifying the tokens it already signed. Rolling back is promoting the other one.",
  inputSchema: byId,
  handler: async (args, ctx) => post(ctx, `${BASE}/${encodeURIComponent(String(args.id))}/promote`),
};

export const revokeSigningKeyTool: McpTool = {
  name: "signing_keys.revoke",
  description:
    "Remove a key from the JWKS. Tokens it signed stop verifying — within ten seconds here, and " +
    "for external verifiers whenever their JWKS cache expires. Refused for the key in use: " +
    "promote another one first.",
  inputSchema: byId,
  handler: async (args, ctx) => post(ctx, `${BASE}/${encodeURIComponent(String(args.id))}/revoke`),
};

export const restoreSigningKeyTool: McpTool = {
  name: "signing_keys.restore",
  description:
    "Undo a revocation — back to `previously_used` if the key ever signed, `standby` if not.",
  inputSchema: byId,
  handler: async (args, ctx) => post(ctx, `${BASE}/${encodeURIComponent(String(args.id))}/restore`),
};

export const signingKeysTools: McpTool[] = [
  listSigningKeysTool,
  generateSigningKeyTool,
  promoteSigningKeyTool,
  revokeSigningKeyTool,
  restoreSigningKeyTool,
];
