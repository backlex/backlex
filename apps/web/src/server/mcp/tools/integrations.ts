import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Third-party integrations over MCP. Every tool proxies the admin REST routes
 * through `fetchInternal`, so the caller's identity, the tenant guards, and
 * the secret masking all come from the one implementation rather than being
 * restated here.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listIntegrationsTool: McpTool = {
  name: "integrations.list",
  description:
    "List the active workspace's connected integrations with health: `status` " +
    "(connected / disabled), consecutive failures, last event, and the reason " +
    "the breaker paused it. Secret config fields come back masked.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal("/api/admin/integrations");
    return textResult(await readJson<unknown>(res));
  },
};

export const integrationCatalogTool: McpTool = {
  name: "integrations.catalog",
  description:
    "Available integration providers — id, label, category, capabilities, and the " +
    "config fields each one needs. Read this before `integrations.connect` to learn " +
    "which keys a provider expects.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal("/api/admin/integrations/catalog");
    return textResult(await readJson<unknown>(res));
  },
};

export const connectIntegrationTool: McpTool = {
  name: "integrations.connect",
  description:
    "Connect (or reconfigure) an integration for the active workspace. One row per " +
    "(workspace, kind). `config` keys come from `integrations.catalog`; secret ones " +
    "are encrypted at rest and never readable again. `events` scopes which record " +
    "events reach it (`posts.*`); omit or null for all.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string" },
      config: { type: "object" },
      events: { type: ["array", "null"], items: { type: "string" } },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const kind = String(args.kind ?? "");
    if (!kind) throw new Error("VALIDATION: kind is required");
    const res = await ctx.fetchInternal("/api/admin/integrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, config: args.config ?? {}, events: args.events ?? null }),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const disconnectIntegrationTool: McpTool = {
  name: "integrations.disconnect",
  description: "Disconnect an integration by id and drop its delivery log.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/admin/integrations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const integrationDeliveriesTool: McpTool = {
  name: "integrations.deliveries",
  description:
    "Recent delivery attempts for one integration, newest first. One row per attempt " +
    "including queue retries; `status` 0 means the provider was misconfigured or " +
    "unreachable. Use this to diagnose why the breaker paused an integration.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 200 },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const qs = args.limit ? `?limit=${Number(args.limit)}` : "";
    const res = await ctx.fetchInternal(
      `/api/admin/integrations/${encodeURIComponent(id)}/deliveries${qs}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const resumeIntegrationTool: McpTool = {
  name: "integrations.resume",
  description:
    "Re-enable an integration the circuit breaker paused, clearing its failure " +
    "counter. Fix the provider config first, or it trips again.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/admin/integrations/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const startIntegrationOAuthTool: McpTool = {
  name: "integrations.oauth_authorize",
  description:
    "Begin an OAuth connect flow for a provider whose catalog entry has `oauth: true` " +
    "(Notion and friends) and return a URL for the operator to open in their browser. " +
    "Save `clientId` and `clientSecret` with `integrations.connect` first — backlex is " +
    "self-hostable, so each workspace registers its own OAuth app. You cannot finish the " +
    "flow yourself: the link is single-use, expires in 10 minutes, and only completes in " +
    "a browser signed in as the same admin. Hand it to the operator and stop.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Integration id from `integrations.list`." } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/admin/integrations/${encodeURIComponent(id)}/oauth/authorize`,
      { method: "POST" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const integrationsTools: McpTool[] = [
  integrationCatalogTool,
  listIntegrationsTool,
  connectIntegrationTool,
  disconnectIntegrationTool,
  integrationDeliveriesTool,
  resumeIntegrationTool,
  startIntegrationOAuthTool,
];
