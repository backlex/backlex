import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";
import { AUTH_HOOK_EVENTS, MAX_AUTH_HOOK_TIMEOUT_MS } from "../../services/auth-hooks";

/**
 * Auth hooks over MCP. Every tool proxies the admin REST routes through
 * `fetchInternal`, so the caller's identity, the workspace scoping, the
 * one-hook-per-event rule and the write-only secret all come from the one
 * implementation.
 *
 * These matter to an agent for a specific reason: an auth hook can BLOCK a
 * sign-up or a sign-in and can decide what is inside an access token, so an
 * agent asked "why is my user getting 403" or "why is `plan` missing from the
 * JWT" needs to be able to see the hooks and test them.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/auth-hooks";

const EVENT_PROP = {
  type: "string",
  enum: [...AUTH_HOOK_EVENTS],
  description:
    "before-user-created: veto a new end-user. custom-access-token: add claims to the JWT. " +
    "password-verification: react to (or refuse) a password sign-in. send-email: deliver the auth mail yourself.",
} as const;

const TARGET_PROPS = {
  targetType: { type: "string", enum: ["url", "function"] },
  url: { type: "string", description: "Required when targetType is `url`." },
  functionName: {
    type: "string",
    description: "Required when targetType is `function` — a backlex function that must already exist.",
  },
} as const;

export const listAuthHooksTool: McpTool = {
  name: "auth_hooks.list",
  description:
    "List the workspace's end-user auth hooks — the app's own code running at sign-up, token mint, " +
    "password check and auth-mail send. Shows the failure policy (`deny` fails the auth action when " +
    "the hook is unreachable) and the breaker state. Start here when a sign-in is being refused or a " +
    "token is missing a claim.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(BASE))),
};

export const createAuthHookTool: McpTool = {
  name: "auth_hooks.create",
  description:
    "Create an auth hook for this workspace's END-USER auth plane (never the platform operators). " +
    "One hook per event. `onError` is REQUIRED and has no safe default: `deny` fails the auth action " +
    "when your service is down, `allow` proceeds without it — which for `custom-access-token` means " +
    "minting a token MISSING the claim your authorizer reads.",
  inputSchema: {
    type: "object",
    properties: {
      event: EVENT_PROP,
      ...TARGET_PROPS,
      onError: { type: "string", enum: ["allow", "deny"] },
      secret: { type: "string", description: "Standard Webhooks signing secret (`whsec_<base64>`)." },
      timeoutMs: { type: "number", minimum: 50, maximum: MAX_AUTH_HOOK_TIMEOUT_MS },
      enabled: { type: "boolean" },
    },
    required: ["event", "targetType", "onError"],
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

export const updateAuthHookTool: McpTool = {
  name: "auth_hooks.update",
  description:
    "Update an auth hook. Omit `secret` to keep the stored one. Re-enabling clears the failure " +
    "counter, so a hook the breaker paused can be brought back without it tripping immediately.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      event: EVENT_PROP,
      ...TARGET_PROPS,
      onError: { type: "string", enum: ["allow", "deny"] },
      secret: { type: "string" },
      timeoutMs: { type: "number", minimum: 50, maximum: MAX_AUTH_HOOK_TIMEOUT_MS },
      enabled: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...body } = args;
    if (!id) throw new Error("VALIDATION: id is required");
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(String(id))}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  },
};

export const deleteAuthHookTool: McpTool = {
  name: "auth_hooks.delete",
  description: "Delete an auth hook. That moment stops consulting it immediately.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(String(args.id))}`, {
          method: "DELETE",
        }),
      ),
    ),
};

export const testAuthHookTool: McpTool = {
  name: "auth_hooks.test",
  description:
    "Send one representative call for this hook's event and report its verdict — the fastest way to " +
    "tell whether a hook is refusing deliberately or is simply unreachable. For `custom-access-token` " +
    "it also reports which returned claims would be DROPPED as reserved, which is the usual reason a " +
    "claim never shows up in the token. Does not affect the breaker.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(String(args.id))}/test`, {
          method: "POST",
        }),
      ),
    ),
};

export const authHooksTools: McpTool[] = [
  listAuthHooksTool,
  createAuthHookTool,
  updateAuthHookTool,
  deleteAuthHookTool,
  testAuthHookTool,
];
