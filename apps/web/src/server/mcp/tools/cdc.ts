import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * CDC sinks over MCP.
 *
 * `cdc.run` is the one an agent debugging a sink reaches for: it advances one
 * page through the same code the cron does and REPORTS the delivery error,
 * which is how a misconfigured destination is found before the failure counter
 * climbs overnight.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/cdc-sinks";

export const listCdcSinksTool: McpTool = {
  name: "cdc.list",
  description:
    "List this workspace's CDC sinks — the changefeed delivered to a webhook or to the workspace's " +
    "own bucket. Shows how far each has replicated, its last error and its failure count. Signing " +
    "secrets are reported as present, never returned.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_a, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(BASE))),
};

export const createCdcSinkTool: McpTool = {
  name: "cdc.create",
  description:
    "Create a CDC sink. Delivery is AT-LEAST-ONCE: the cursor advances only after a batch is " +
    "acknowledged, so a retry re-sends it and every record carries a stable `key` for the " +
    "destination to deduplicate on. `shape` is a flat filter naming the subset to replicate, and " +
    "it is the only narrowing knob — a sink reads unconditionally.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      collection: { type: "string" },
      destination: { type: "string", enum: ["webhook", "storage"] },
      config: {
        type: "object",
        description: "`{ url, secret?, headers? }` for a webhook; `{ prefix? }` for storage.",
      },
      shape: { type: "string" },
      fields: { type: "string" },
      batchSize: { type: "number", minimum: 1, maximum: 500 },
    },
    required: ["name", "collection", "destination", "config"],
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

export const updateCdcSinkTool: McpTool = {
  name: "cdc.update",
  description:
    "Update a sink. Omit `config.secret` to keep the stored one. Re-enabling clears the failure " +
    "counter. `resetCursor: true` replays the collection from the beginning — the one operation " +
    "here that can flood a destination.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      config: { type: "object" },
      shape: { type: "string" },
      fields: { type: "string" },
      batchSize: { type: "number", minimum: 1, maximum: 500 },
      enabled: { type: "boolean" },
      resetCursor: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...patch } = args as Record<string, unknown>;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(String(id))}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ),
    );
  },
};

export const runCdcSinkTool: McpTool = {
  name: "cdc.run",
  description:
    "Advance a sink by one page now, through the same code the cron tick runs, and report what it " +
    "delivered or the delivery error. The fastest way to tell whether a sink is stuck because the " +
    "destination is refusing it or because there is nothing to send.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(String(args.id))}/run`, {
          method: "POST",
        }),
      ),
    ),
};

export const deleteCdcSinkTool: McpTool = {
  name: "cdc.delete",
  description: "Delete a sink. The destination keeps whatever it already received.",
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

export const cdcTools: McpTool[] = [
  listCdcSinksTool,
  createCdcSinkTool,
  updateCdcSinkTool,
  runCdcSinkTool,
  deleteCdcSinkTool,
];
