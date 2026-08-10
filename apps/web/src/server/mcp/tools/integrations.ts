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

const SYNCS = "/api/admin/integrations/syncs";

export const listIntegrationSyncsTool: McpTool = {
  name: "integrations.syncs",
  description:
    "List scheduled pulls from source integrations into collections, with health: when each last ran, " +
    "how many rows landed, the last error, and whether the breaker paused it. Use this to answer \"why is " +
    "my collection not updating\".",
  inputSchema: {
    type: "object",
    properties: { integrationId: { type: "string", description: "Filter to one connection." } },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const filter = args.integrationId ? `?integrationId=${encodeURIComponent(String(args.integrationId))}` : "";
    const res = await ctx.fetchInternal(`${SYNCS}${filter}`);
    return textResult(await readJson<unknown>(res));
  },
};

export const createIntegrationSyncTool: McpTool = {
  name: "integrations.create_sync",
  description:
    "Schedule a sync between an integration and a collection. `direction: pull` (the default) brings rows " +
    "in; `direction: push` mirrors the collection out to a destination — the provider must declare that " +
    "capability. `settings` keys come from the catalog's `sourceSettings` / `destinationSettings` for that " +
    "provider — anything else is rejected. `mapping` is read in the direction of travel: external → " +
    "collection field on a pull, collection field → external column on a push. The collection must be " +
    "MANAGED (adopted tables are refused); a pull's targets must be writable fields, and pulled rows get a " +
    "namespaced primary key so they never overwrite rows a person created. Set `intervalMinutes: 0` for " +
    "manual-only.",
  inputSchema: {
    type: "object",
    properties: {
      integrationId: { type: "string" },
      collection: { type: "string", description: "Managed collection slug." },
      direction: {
        type: "string",
        enum: ["pull", "push"],
        description: "Rows in (default) or the collection mirrored out.",
      },
      settings: { type: "object", additionalProperties: true },
      mapping: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Pull: external field → collection field. Push: collection field → destination column. At least one entry.",
      },
      childMappings: {
        type: "object",
        description:
          "Pull only. Where a record's CHILD rows land, keyed by the group name the provider returns " +
          "(e.g. `items` for an order's lines). Each value is `{ collection, parentField, mapping }`: the " +
          "managed collection the lines go in, the relation column pointing back at the header (filled from " +
          "the parent's own id, never from provider data), and an external → field mapping. Children are " +
          "upserted, never reconciled — a line removed at the provider stays in the collection.",
        additionalProperties: {
          type: "object",
          properties: {
            collection: { type: "string" },
            parentField: { type: "string" },
            mapping: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["collection", "parentField", "mapping"],
        },
      },
      intervalMinutes: { type: "number", description: "0 = manual only. Default 60. Max 10080." },
      enabled: { type: "boolean" },
    },
    required: ["integrationId", "collection", "mapping"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(SYNCS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const updateIntegrationSyncTool: McpTool = {
  name: "integrations.update_sync",
  description:
    "Patch a sync. Changing `settings` resets the resume cursor, because a row offset from one spreadsheet " +
    "points at unrelated rows in another. Re-enabling clears the failure counter.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      settings: { type: "object", additionalProperties: true },
      mapping: { type: "object", additionalProperties: { type: "string" } },
      childMappings: {
        type: "object",
        description:
          "Pull only. Where a record's CHILD rows land, keyed by the group name the provider returns " +
          "(e.g. `items` for an order's lines). Each value is `{ collection, parentField, mapping }`: the " +
          "managed collection the lines go in, the relation column pointing back at the header (filled from " +
          "the parent's own id, never from provider data), and an external → field mapping. Children are " +
          "upserted, never reconciled — a line removed at the provider stays in the collection.",
        additionalProperties: {
          type: "object",
          properties: {
            collection: { type: "string" },
            parentField: { type: "string" },
            mapping: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["collection", "parentField", "mapping"],
        },
      },
      intervalMinutes: { type: "number" },
      enabled: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...patch } = args as { id?: string } & Record<string, unknown>;
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const deleteIntegrationSyncTool: McpTool = {
  name: "integrations.delete_sync",
  description: "Delete a sync. Rows already pulled stay in the collection; only the schedule goes.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(id)}`, { method: "DELETE" });
    return textResult(await readJson<unknown>(res));
  },
};

export const runIntegrationSyncTool: McpTool = {
  name: "integrations.run_sync",
  description:
    "Run one sync now and report what landed. Use it after creating a sync to see the first pull succeed " +
    "or fail with a reason, rather than waiting for the schedule. Bounded to 20 pages / 2000 rows; " +
    "`complete: false` means more pages are pending and the next run resumes where this one stopped.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(id)}/run`, { method: "POST" });
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
  listIntegrationSyncsTool,
  createIntegrationSyncTool,
  updateIntegrationSyncTool,
  deleteIntegrationSyncTool,
  runIntegrationSyncTool,
];
