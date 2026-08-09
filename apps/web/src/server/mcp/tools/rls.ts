import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Row-level security over MCP.
 *
 * `rls.plan` before `rls.apply` is the order that matters, and the tool
 * descriptions say why: applying compiles the workspace's permission rules into
 * DDL against every physical table, and the `omissions` it reports are the
 * parts a policy cannot carry. An agent that applies without reading them has
 * told the operator their database enforces something it does not.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/rls";
const none = { type: "object", properties: {}, additionalProperties: false } as const;

export const rlsStatusTool: McpTool = {
  name: "rls.status",
  description:
    "Whether Postgres row-level security is installed for this workspace, and how far it has DRIFTED " +
    "from the current permission rules. Policies are a snapshot: editing a role changes the API " +
    "immediately and the database not at all, so `stale` and `missing` are the gap. Postgres only.",
  inputSchema: none,
  handler: async (_a, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}/status`))),
};

export const rlsPlanTool: McpTool = {
  name: "rls.plan",
  description:
    "The exact statements an apply would run, plus the `omissions` — a field allow-list, a condition " +
    "that walks a relation, and `_near` cannot be carried by a policy, so a direct database reader " +
    "sees a COARSER view than the API. Read this before applying. Changes nothing.",
  inputSchema: none,
  handler: async (_a, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}/plan`))),
};

export const rlsApplyTool: McpTool = {
  name: "rls.apply",
  description:
    "Install the policies. Idempotent — each is dropped and recreated, so re-running after a rule " +
    "change replaces rather than accumulates. Refused outright if backlex does not own a covered " +
    "table, because enabling row security there would filter backlex's own queries.",
  inputSchema: none,
  handler: async (_a, ctx) =>
    textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}/apply`, { method: "POST" }))),
};

export const rlsDisableTool: McpTool = {
  name: "rls.disable",
  description:
    "Drop the policies backlex installed. Row security itself is disabled only on tables left with " +
    "no policies at all, so a hand-written one keeps its table protected.",
  inputSchema: none,
  handler: async (_a, ctx) =>
    textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}/disable`, { method: "POST" }))),
};

export const rlsTools: McpTool[] = [rlsStatusTool, rlsPlanTool, rlsApplyTool, rlsDisableTool];
