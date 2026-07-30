import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Sync hooks over MCP. Every tool proxies the admin REST routes through
 * `fetchInternal`, so the caller's identity, the workspace scoping and the
 * write-only secret all come from the one implementation.
 *
 * These matter to an agent for a specific reason: a sync hook can BLOCK writes,
 * so an agent debugging "why did my insert 403" needs to be able to see the
 * hooks and test them.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/sync-hooks";

export const listSyncHooksTool: McpTool = {
  name: "sync_hooks.list",
  description:
    "List the workspace's sync hooks — external services that run BEFORE a write and can reject " +
    "it. Shows the failure policy (`deny` blocks writes when the hook is unreachable), whether the " +
    "hook may patch payloads, and the breaker state. Start here when a write is being refused.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(BASE))),
};

export const createSyncHookTool: McpTool = {
  name: "sync_hooks.create",
  description:
    "Create a sync hook. `events` are `<collection>.beforeCreate|beforeUpdate|beforeDelete` " +
    "(or `<collection>.*` / `*.<phase>` / `*`). `onError` is REQUIRED and has no safe default: " +
    "`deny` blocks writes when your service is down, `allow` lets them through and drops the " +
    "guarantee. `canMutate` lets the hook patch the payload; leave it off for a validator.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      url: { type: "string" },
      events: { type: "array", items: { type: "string" } },
      onError: { type: "string", enum: ["allow", "deny"] },
      secret: { type: "string" },
      timeoutMs: { type: "number", minimum: 50, maximum: 10000 },
      canMutate: { type: "boolean" },
      priority: { type: "number" },
      enabled: { type: "boolean" },
    },
    required: ["name", "url", "events", "onError"],
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

export const updateSyncHookTool: McpTool = {
  name: "sync_hooks.update",
  description:
    "Update a sync hook. Omit `secret` to keep the stored one. Re-enabling clears the failure " +
    "counter, so a hook the breaker paused can be brought back without it tripping immediately.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      events: { type: "array", items: { type: "string" } },
      onError: { type: "string", enum: ["allow", "deny"] },
      secret: { type: "string" },
      timeoutMs: { type: "number", minimum: 50, maximum: 10000 },
      canMutate: { type: "boolean" },
      priority: { type: "number" },
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

export const deleteSyncHookTool: McpTool = {
  name: "sync_hooks.delete",
  description: "Delete a sync hook. Writes stop being gated by it immediately.",
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

export const testSyncHookTool: McpTool = {
  name: "sync_hooks.test",
  description:
    "Send one synthetic call to a hook and report its verdict — the fastest way to tell whether a " +
    "hook is rejecting writes deliberately or is simply unreachable. Does not affect the breaker.",
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

export const syncHooksTools: McpTool[] = [
  listSyncHooksTool,
  createSyncHookTool,
  updateSyncHookTool,
  deleteSyncHookTool,
  testSyncHookTool,
];
