import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listWebhooks: McpTool = {
  name: "webhooks.list",
  description:
    "List outgoing webhooks for the active workspace. Each row shows the " +
    "URL, subscribed event patterns, header overrides, and active state. " +
    "Permission: requires `read` on `system_webhooks` (admin-only by default).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/webhooks`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const createWebhook: McpTool = {
  name: "webhooks.create",
  description:
    "Register a new outgoing webhook. `events` is an array of dot-patterns " +
    "(`items.<slug>.created`, `items.*.updated`, etc.). A `secret`, when " +
    "supplied, signs each delivery via HMAC-SHA256 in `X-Workeros-Signature`.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      url: { type: "string", description: "Target HTTPS URL." },
      events: { type: "array", description: "Array of event patterns." },
      headers: { type: "object", description: "Custom request headers." },
      secret: { type: "string", description: "HMAC signing secret." },
      active: { type: "boolean" },
    },
    required: ["name", "url", "events"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const deleteWebhook: McpTool = {
  name: "webhooks.delete",
  description: "Delete a webhook by id.",
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
      `/api/webhooks/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const testWebhook: McpTool = {
  name: "webhooks.test",
  description:
    "Fire a synthetic test delivery against a webhook to verify URL + " +
    "headers + signing work end-to-end. Useful before relying on real " +
    "events. Returns the upstream HTTP response shape.",
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
      `/api/webhooks/${encodeURIComponent(id)}/test`,
      { method: "POST" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const webhooksTools: McpTool[] = [
  listWebhooks,
  createWebhook,
  deleteWebhook,
  testWebhook,
];
