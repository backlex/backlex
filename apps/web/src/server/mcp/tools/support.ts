import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Captcha and impersonation over MCP.
 *
 * `support.impersonate` is the one tool here an agent should hesitate over, and
 * its description says so: it hands back a working credential for somebody
 * else's account. The reason it asks for is not paperwork — it is the row that
 * makes the act reviewable afterwards.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const CAPTCHA = "/api/admin/captcha";
const IMP = "/api/admin/impersonation";

export const getCaptchaTool: McpTool = {
  name: "captcha.get",
  description:
    "Read the workspace's captcha configuration — provider, site key, and which endpoints it " +
    "gates. The secret is reported as present or absent, never returned.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_a, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(CAPTCHA))),
};

export const setCaptchaTool: McpTool = {
  name: "captcha.set",
  description:
    "Configure the captcha. `onError` is REQUIRED and has no safe default: `allow` means the gate " +
    "stops working exactly when the provider is having a bad day — which an attacker can arrange — " +
    "and `deny` turns the provider's outage into an outage of your sign-up. `protect` is a list " +
    "because the endpoints cost different things.",
  inputSchema: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["turnstile", "hcaptcha", "recaptcha"] },
      siteKey: { type: "string" },
      secretKey: { type: "string", description: "Write-only. Omit to keep the stored one." },
      protect: {
        type: "array",
        items: { type: "string", enum: ["sign-up", "sign-in", "password-reset", "forms"] },
      },
      onError: { type: "string", enum: ["allow", "deny"] },
      enabled: { type: "boolean" },
    },
    required: ["provider", "siteKey", "protect", "onError"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(CAPTCHA, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        }),
      ),
    ),
};

export const removeCaptchaTool: McpTool = {
  name: "captcha.remove",
  description: "Remove the captcha. Every gated endpoint stops asking on the next request.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_a, ctx) =>
    textResult(await readJson<unknown>(await ctx.fetchInternal(CAPTCHA, { method: "DELETE" }))),
};

export const listImpersonationsTool: McpTool = {
  name: "support.impersonations",
  description:
    "The impersonation audit trail — who acted as which end-user, why, whether it was read-only, " +
    "and whether it is still live.",
  inputSchema: {
    type: "object",
    properties: {
      activeOnly: { type: "boolean" },
      limit: { type: "number", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const q = new URLSearchParams();
    if (args.activeOnly) q.set("activeOnly", "true");
    if (args.limit) q.set("limit", String(args.limit));
    const qs = q.toString();
    return textResult(await readJson<unknown>(await ctx.fetchInternal(`${IMP}${qs ? `?${qs}` : ""}`)));
  },
};

export const impersonateTool: McpTool = {
  name: "support.impersonate",
  description:
    "Act as one of this workspace's end-users, to see what they see. Returns a WORKING access " +
    "token for their account — treat it as a credential and do not log it. Read-only unless you " +
    "pass `readOnly: false`, capped at 60 minutes, and recorded: the `reason` you give is what " +
    "makes the act reviewable afterwards, so make it specific.",
  inputSchema: {
    type: "object",
    properties: {
      subjectUserId: { type: "string" },
      reason: { type: "string", minLength: 3 },
      readOnly: { type: "boolean" },
      minutes: { type: "number", minimum: 1, maximum: 60 },
    },
    required: ["subjectUserId", "reason"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(IMP, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        }),
      ),
    ),
};

export const endImpersonationTool: McpTool = {
  name: "support.end_impersonation",
  description:
    "End an impersonation now. Takes effect on the next request — the token names the audit row, " +
    "and every request re-reads it.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${IMP}/${encodeURIComponent(String(args.id))}/end`, {
          method: "POST",
        }),
      ),
    ),
};

export const supportTools: McpTool[] = [
  getCaptchaTool,
  setCaptchaTool,
  removeCaptchaTool,
  listImpersonationsTool,
  impersonateTool,
  endImpersonationTool,
];
