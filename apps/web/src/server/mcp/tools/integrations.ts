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
const BASE = "/api/admin/integrations";

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
        enum: ["pull", "push", "inbound", "listing"],
        description:
          "Rows in (default), the collection mirrored out, `inbound` — nothing to poll, existing to " +
          "receive the provider's webhook deliveries — or `listing`, which puts products ON SALE at a " +
          "marketplace and writes the verdict back. A `pull` sync may ALSO have an endpoint; that is the " +
          "normal case for a marketplace, and the poll is what repairs the deliveries a webhook loses.",
      },
      matchField: {
        type: "string",
        description:
          "The collection field a delivery is matched on, for a provider whose webhook updates rows it did " +
          "not create (a carrier's tracking events name a shipment id). Read the catalog's `webhooks[kind]`: " +
          "required when `landing` is `patch`, refused when it is `upsert`.",
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
      categoryField: {
        type: "string",
        description:
          "Listing only, and required for it. The product column naming the LOCAL category — the mapping " +
          "itself is one row per value, set with `integrations.map_listing_category`.",
      },
      outputsMapping: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Listing only, and required for it. Read the OTHER way from `mapping`: provider output key → the " +
          "column a marketplace's verdict is written to (`listingId`, `listingStatus`, `listingError`, " +
          "`listedAt`). Without one a batch would be published and every answer discarded. The columns are " +
          "on the VARIANT collection when the sync declares one, because a marketplace rules per unit.",
      },
      intervalMinutes: {
        type: "number",
        description:
          "0 = manual only. Default 60, and 0 for a listing — a publish is an outward, hard-to-undo act at " +
          "a live marketplace, so putting it on a schedule is the operator's decision.",
      },
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

export const runIntegrationTaskTool: McpTool = {
  name: "integrations.run_task",
  description:
    "Run a provider TASK against one row — booking a shipment and receiving a tracking number and a label " +
    "is the shape. Unlike a sync this is invoked deliberately, never scheduled, and runs at most ONCE per " +
    "row: a second call returns the first run's outputs instead of acting again, because the effect at the " +
    "provider costs money. Only pass `force: true` when a human has decided the action genuinely has to " +
    "happen a second time. `outputMapping` says which of the task's declared outputs land on which " +
    "collection fields — read `integrations.catalog` for what a task declares.",
  inputSchema: {
    type: "object",
    properties: {
      integrationId: { type: "string" },
      task: { type: "string", description: "Provider-declared task id, e.g. `create_shipment`." },
      collection: { type: "string", description: "Managed collection the row lives in." },
      itemId: { type: "string", description: "Primary key of the row to act on." },
      settings: { type: "object", additionalProperties: true },
      outputMapping: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Task output key → collection field. Undeclared outputs are refused.",
      },
      force: {
        type: "boolean",
        description:
          "Re-run a task that already succeeded. Off by default — a repeat has a real cost at the provider.",
      },
    },
    required: ["integrationId", "task", "collection", "itemId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { integrationId, task, ...body } = args as {
      integrationId?: string;
      task?: string;
    } & Record<string, unknown>;
    if (!integrationId || !task) throw new Error("VALIDATION: integrationId and task are required");
    const res = await ctx.fetchInternal(
      `${BASE}/${encodeURIComponent(integrationId)}/tasks/${encodeURIComponent(task)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const integrationTaskRunsTool: McpTool = {
  name: "integrations.task_runs",
  description:
    "What has already been done to one row and what it produced — which orders have a label, and which " +
    "are still waiting. Read this before running a task if you need to know whether it already happened.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      itemId: { type: "string" },
    },
    required: ["collection", "itemId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = args as { collection?: string; itemId?: string };
    if (!a.collection || !a.itemId) throw new Error("VALIDATION: collection and itemId are required");
    const res = await ctx.fetchInternal(
      `${BASE}/task-runs?collection=${encodeURIComponent(a.collection)}&itemId=${encodeURIComponent(a.itemId)}`,
    );
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
      matchField: {
        type: "string",
        description: "The collection field a patching delivery is matched on.",
      },
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

export const enableIntegrationWebhookTool: McpTool = {
  name: "integrations.enable_webhook",
  description:
    "Turn on the endpoint a sync receives the provider's deliveries on, and register it at the provider " +
    "where that is possible — so a marketplace pushes order status changes instead of being polled, and a " +
    "carrier pushes tracking scans. The SECRET comes back exactly once and is never readable again: show it " +
    "to the operator, do not store it elsewhere. Calling this again rotates the secret and keeps the URL. A " +
    "failed registration does NOT undo the endpoint — `registrationError` says what to retry. Read the " +
    "catalog's `webhooks[kind]` first: a `patch` provider needs the sync's `matchField` set before this works.",
  inputSchema: {
    type: "object",
    properties: {
      syncId: { type: "string" },
      events: {
        type: "array",
        items: { type: "string" },
        description:
          "Event keys from the catalog's `webhooks[kind].events`. Empty or absent = every event the " +
          "provider declares.",
      },
    },
    required: ["syncId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { syncId, ...body } = args as { syncId?: string } & Record<string, unknown>;
    if (!syncId) throw new Error("VALIDATION: syncId is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(syncId)}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const updateIntegrationWebhookEventsTool: McpTool = {
  name: "integrations.update_webhook_events",
  description:
    "Change which events an endpoint accepts. Empty means every event the provider declares. Where the " +
    "provider filters server-side this re-registers the endpoint, which rotates the secret as a side effect.",
  inputSchema: {
    type: "object",
    properties: {
      syncId: { type: "string" },
      events: { type: "array", items: { type: "string" } },
    },
    required: ["syncId", "events"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { syncId, events } = args as { syncId?: string; events?: unknown };
    if (!syncId) throw new Error("VALIDATION: syncId is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(syncId)}/webhook`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const disableIntegrationWebhookTool: McpTool = {
  name: "integrations.disable_webhook",
  description:
    "Tear an endpoint down. The provider is asked to stop first, but cannot block it — deliveries to the " +
    "old URL then resolve to nothing. The sync itself, and every row it already wrote, stay.",
  inputSchema: {
    type: "object",
    properties: { syncId: { type: "string" } },
    required: ["syncId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const syncId = String(args.syncId ?? "");
    if (!syncId) throw new Error("VALIDATION: syncId is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(syncId)}/webhook`, {
      method: "DELETE",
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const integrationInboundDeliveriesTool: McpTool = {
  name: "integrations.inbound_deliveries",
  description:
    "What a provider delivered to one sync's endpoint, newest first — the answer to \"the marketplace says " +
    "it sent it\". `status` distinguishes what happened: `applied` wrote rows, `unmatched` found no row " +
    "holding the id the delivery named, `filtered` was an event this endpoint is not subscribed to, " +
    "`ignored` was a ping or an event kind we do not read, `duplicate` was a retry of something already " +
    "applied, `rejected` did not present the secret, and `failed` was ours.",
  inputSchema: {
    type: "object",
    properties: { syncId: { type: "string" } },
    required: ["syncId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const syncId = String(args.syncId ?? "");
    if (!syncId) throw new Error("VALIDATION: syncId is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(syncId)}/deliveries`);
    return textResult(await readJson<unknown>(res));
  },
};

// ── Listings ─────────────────────────────────────────────────────────────────

export const listingCategoriesTool: McpTool = {
  name: "integrations.listing_categories",
  description:
    "The marketplace's own category tree, flattened — every node with `parentId` and `leaf`. A product may " +
    "only be listed against a LEAF. Ask this before mapping anything; the tree runs to thousands of nodes " +
    "and a category id guessed from a name will be refused at publish time. Keyed on the CONNECTION, not a " +
    "sync, so it answers while an operator is still deciding whether to make one.",
  inputSchema: {
    type: "object",
    properties: { integrationId: { type: "string" } },
    required: ["integrationId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.integrationId ?? "");
    if (!id) throw new Error("VALIDATION: integrationId is required");
    const res = await ctx.fetchInternal(`${BASE}/${encodeURIComponent(id)}/listing/categories`);
    return textResult(await readJson<unknown>(res));
  },
};

export const listingAttributesTool: McpTool = {
  name: "integrations.listing_attributes",
  description:
    "What one leaf category DEMANDS of a product, with each attribute's closed value set and three flags " +
    "that decide how to answer it: `required` (refused without it), `allowCustom` (free text is accepted) " +
    "and `variant` (two products differing only here are one product with two variants). Every `required` " +
    "attribute must appear in the mapping's `attributes` or the marketplace rejects the listing.",
  inputSchema: {
    type: "object",
    properties: { integrationId: { type: "string" }, categoryId: { type: "string" } },
    required: ["integrationId", "categoryId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.integrationId ?? "");
    const categoryId = String(args.categoryId ?? "");
    if (!id || !categoryId) throw new Error("VALIDATION: integrationId and categoryId are required");
    const res = await ctx.fetchInternal(
      `${BASE}/${encodeURIComponent(id)}/listing/attributes?categoryId=${encodeURIComponent(categoryId)}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const listingLookupTool: McpTool = {
  name: "integrations.listing_lookup",
  description:
    "Search a registry a listing has to name — a brand list, which runs to hundreds of thousands of rows " +
    "and so is searched rather than browsed. `lookup` must be one the provider declares; an undeclared key " +
    "is refused rather than passed on.",
  inputSchema: {
    type: "object",
    properties: {
      integrationId: { type: "string" },
      lookup: { type: "string", description: "The registry key, e.g. `brands`." },
      query: { type: "string" },
      cursor: { type: "string" },
    },
    required: ["integrationId", "lookup"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.integrationId ?? "");
    if (!id) throw new Error("VALIDATION: integrationId is required");
    const qs = new URLSearchParams({ lookup: String(args.lookup ?? "") });
    if (args.query) qs.set("query", String(args.query));
    if (args.cursor) qs.set("cursor", String(args.cursor));
    const res = await ctx.fetchInternal(`${BASE}/${encodeURIComponent(id)}/listing/lookup?${qs}`);
    return textResult(await readJson<unknown>(res));
  },
};

export const listingMapsTool: McpTool = {
  name: "integrations.listing_maps",
  description:
    "How this sync's local categories are mapped onto the marketplace's. A product whose category has no " +
    "row here is SKIPPED by a run and counted as `unmapped` — which is the usual reason a publish looks " +
    "like it did nothing.",
  inputSchema: {
    type: "object",
    properties: { syncId: { type: "string" } },
    required: ["syncId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.syncId ?? "");
    if (!id) throw new Error("VALIDATION: syncId is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(id)}/listing/maps`);
    return textResult(await readJson<unknown>(res));
  },
};

export const mapListingCategoryTool: McpTool = {
  name: "integrations.map_listing_category",
  description:
    "Map one of the workspace's own categories onto a marketplace LEAF category, and answer what that " +
    "category demands. An upsert keyed on the local value, so calling it again re-maps rather than adding " +
    "a second row. Each entry in `attributes` carries exactly ONE of: `valueId` (a value from the closed " +
    "set), `custom` (free text, only where `allowCustom`), or `field` (the product/variant column to read " +
    "the value from) — the last being what makes a size or a colour describe every unit without typing " +
    "each one. Read `integrations.listing_attributes` for the category first.",
  inputSchema: {
    type: "object",
    properties: {
      syncId: { type: "string" },
      localValue: { type: "string", description: "The value found in the sync's category field, verbatim." },
      categoryId: { type: "string", description: "The marketplace's LEAF category id." },
      attributes: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            valueId: { type: "string" },
            custom: { type: "string" },
            field: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    required: ["syncId", "localValue", "categoryId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { syncId, ...body } = args as Record<string, unknown>;
    const id = String(syncId ?? "");
    if (!id) throw new Error("VALIDATION: syncId is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(id)}/listing/maps`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const listingBatchesTool: McpTool = {
  name: "integrations.listing_batches",
  description:
    "What this sync published and what came back, newest first. A batch stays `open` until the marketplace " +
    "has ruled on every unit — which can take hours — so `pendingCount` is what to watch. The per-unit " +
    "verdict is written onto the rows themselves through the sync's `outputsMapping`; read those columns " +
    "for the reason a product was refused.",
  inputSchema: {
    type: "object",
    properties: { syncId: { type: "string" } },
    required: ["syncId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.syncId ?? "");
    if (!id) throw new Error("VALIDATION: syncId is required");
    const res = await ctx.fetchInternal(`${SYNCS}/${encodeURIComponent(id)}/listing/batches`);
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
  runIntegrationTaskTool,
  integrationTaskRunsTool,
  enableIntegrationWebhookTool,
  updateIntegrationWebhookEventsTool,
  disableIntegrationWebhookTool,
  integrationInboundDeliveriesTool,
  listingCategoriesTool,
  listingAttributesTool,
  listingLookupTool,
  listingMapsTool,
  mapListingCategoryTool,
  listingBatchesTool,
];
