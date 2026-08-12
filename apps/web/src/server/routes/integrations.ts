import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, isAppError, SYSTEM_ROLES } from "@backlex/core";
import {
  INTEGRATION_CATALOG,
  INTEGRATION_FIELDS,
  INTEGRATION_KINDS,
  DESTINATION_COLUMNS,
  DESTINATION_SETTING_FIELDS,
  INTEGRATION_LISTINGS,
  INTEGRATION_TASKS,
  INTEGRATION_WEBHOOKS,
  SOURCE_CHILD_GROUPS,
  SOURCE_SETTING_FIELDS,
} from "@backlex/integrations";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  connectIntegration,
  disconnectIntegration,
  listIntegrationDeliveries,
  listIntegrations,
  resumeIntegration,
} from "../services/integrations";
import { logActivity } from "../services/activity";
import { beginOAuth, completeOAuth, oauthRedirectUri } from "../services/integrations-oauth";
import {
  createSync,
  deleteSync,
  getSync,
  listSyncs,
  runSync,
  SYNC_DIRECTIONS,
  type SyncDirection,
  updateSync,
} from "../services/integration-syncs";
import {
  deleteListingMap,
  listListingBatches,
  listListingMaps,
  readListingAttributes,
  readListingCategories,
  runListingSync,
  searchListingRegistry,
  upsertListingMap,
} from "../services/integration-listings";
import { listTaskRuns, runTask } from "../services/integration-tasks";
import {
  disableWebhook,
  enableWebhook,
  listDeliveries,
  updateWebhookEvents,
} from "../services/integration-webhooks";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";

const IntegrationView = z
  .object({
    id: z.string(),
    kind: z.string(),
    events: z.array(z.string()).nullable(),
    status: z.string(),
    config: z.record(z.string(), z.unknown()),
    lastEventAt: z.union([z.number(), z.date()]).nullable(),
    createdAt: z.union([z.number(), z.date()]).nullable(),
    consecutiveFailures: z.number(),
    lastFailureAt: z.union([z.number(), z.date()]).nullable(),
    disabledReason: z.string().nullable(),
  })
  .openapi("Integration");

const DeliveryView = z
  .object({
    id: z.string(),
    integrationId: z.string(),
    event: z.string(),
    status: z.number(),
    ms: z.number(),
    error: z.string().nullable(),
    attempts: z.number(),
    deliveredAt: z.union([z.number(), z.date()]),
  })
  .openapi("IntegrationDelivery");

const CatalogView = z
  .object({
    kinds: z.array(z.string()),
    fields: z.record(z.string(), z.unknown()),
    /** Registry metadata — lets the connect UI group providers by category
     *  and hide the ones that can't do what the caller is looking for. */
    providers: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        category: z.string(),
        capabilities: z.array(z.string()),
        /** Show "Connect with …" instead of a paste-a-key form. */
        oauth: z.boolean(),
        /** Warn that row CONTENTS leave the instance for this provider. */
        recordPayload: z.boolean(),
      }),
    ),
    /** The exact URI to register with each OAuth provider. Deriving it in the
     *  UI would get it wrong behind a proxy; the server knows its own APP_URL. */
    oauthRedirectUri: z.string(),
    /** Per-sync settings each source provider needs, keyed by kind. */
    sourceSettings: z.record(z.string(), z.unknown()),
    /** Same, for providers that receive rows rather than supply them. */
    destinationSettings: z.record(z.string(), z.unknown()),
    /** Child groups a source hands back — an order's lines, say — keyed by
     *  kind. A kind that is absent returns flat records and has none. */
    sourceChildGroups: z.record(z.string(), z.unknown()),
    /** Mapping targets for destinations with a closed column set, keyed by
     *  kind. A kind that is absent takes any column name. */
    destinationColumns: z.record(z.string(), z.unknown()),
    /** Tasks each provider declares, with their settings and declared outputs.
     *  A caller has to map the outputs onto its own columns before it can
     *  invoke anything, so they travel with the catalog rather than in a
     *  second list somebody has to keep in step. */
    tasks: z.record(z.string(), z.unknown()),
    /** What each provider that CALLS US needs a form to know: how the secret is
     *  used, which header carries it, which events exist, whether a delivery
     *  replaces a row or patches one, and whether we can register the endpoint
     *  ourselves. A kind that is absent sends no webhooks. */
    webhooks: z.record(z.string(), z.unknown()),
    /**
     * What a listing form needs before it can ask anything, keyed by kind.
     *
     * Only the part that is FIXED per provider: the columns a product row maps
     * onto, the per-unit columns, the fields a verdict writes back, and which
     * registries can be searched. The taxonomy itself is deliberately absent —
     * it is fetched per connection with the seller's own credentials, runs to
     * hundreds of kilobytes, and changes without us.
     */
    listings: z.record(z.string(), z.unknown()),
  })
  .openapi("IntegrationCatalog");

const TaskRunInputSchema = z
  .object({
    collection: z.string().min(1).openapi({ description: "Managed collection the row lives in." }),
    itemId: z.string().min(1).openapi({ description: "Primary key of the row to act on." }),
    settings: z.record(z.string(), z.unknown()).optional().openapi({
      description: "Per-invocation settings. Keys come from the task's declared fields; anything else is refused.",
    }),
    outputMapping: z.record(z.string(), z.string()).optional().openapi({
      description: "Task output key → collection field. Undeclared outputs and non-writable targets are refused.",
    }),
    force: z.boolean().optional().openapi({
      description: "Re-run a task that already succeeded. Off by default — a repeat has a cost at the provider.",
    }),
  })
  .openapi("IntegrationTaskRunInput");

const TaskRunView = z
  .object({
    id: z.string(),
    integrationId: z.string(),
    task: z.string(),
    status: z.string(),
    outputs: z.record(z.string(), z.unknown()),
    artifactKey: z.string().nullable(),
    error: z.string().nullable(),
    attempts: z.number(),
    updatedAt: z.union([z.number(), z.date()]).nullable(),
  })
  .openapi("IntegrationTaskRun");

const ChildMapping = z
  .object({
    collection: z.string().min(1).openapi({
      description: "Managed collection the child rows land in (e.g. `order_items`).",
    }),
    parentField: z.string().min(1).openapi({
      description:
        "Relation column on the child collection pointing back at the header. " +
        "Filled from the parent's own id — never from provider data.",
    }),
    mapping: z.record(z.string(), z.string()).openapi({
      description: "`external field → child collection field`, same shape as the parent mapping.",
    }),
  })
  .openapi("IntegrationSyncChildMapping");

const SyncView = z
  .object({
    id: z.string(),
    integrationId: z.string(),
    collection: z.string(),
    direction: z.string(),
    settings: z.record(z.string(), z.unknown()),
    mapping: z.record(z.string(), z.string()),
    childMappings: z.record(z.string(), ChildMapping),
    intervalMinutes: z.number(),
    enabled: z.boolean(),
    resuming: z.boolean(),
    lastRunAt: z.union([z.number(), z.date()]).nullable(),
    lastRowCount: z.number(),
    lastError: z.string().nullable(),
    consecutiveFailures: z.number(),
    disabledReason: z.string().nullable(),
    matchField: z.string().nullable(),
    /** The endpoint, described — never the secret. Null when there is none. */
    webhook: z
      .object({
        path: z.string(),
        events: z.array(z.string()),
        registered: z.boolean(),
      })
      .nullable(),
    createdAt: z.union([z.number(), z.date()]).nullable(),
  })
  .openapi("IntegrationSync");

const WebhookEndpointView = z
  .object({
    url: z.string().openapi({ description: "The absolute URL to give the provider." }),
    secret: z
      .string()
      .nullable()
      .openapi({ description: "Returned ONCE, by the call that minted it. Lost means rotate." }),
    events: z.array(z.string()),
    registered: z.boolean().openapi({ description: "True when we told the provider about it ourselves." }),
    registrationError: z.string().optional().openapi({
      description: "The endpoint is live and the provider was not told. Retry by calling again.",
    }),
  })
  .openapi("IntegrationWebhookEndpoint");

const InboundDeliveryView = z
  .object({
    id: z.string(),
    syncId: z.string(),
    event: z.string(),
    status: z.string(),
    rowsWritten: z.number(),
    error: z.string().nullable(),
    createdAt: z.union([z.number(), z.date()]).nullable(),
  })
  .openapi("IntegrationInboundDelivery");

const WebhookEventsInput = z
  .object({
    events: z.array(z.string().min(1)).openapi({
      description: "Event keys from the catalog's `webhooks[kind].events`. Empty = every event.",
    }),
  })
  .openapi("IntegrationWebhookEventsInput");

const WebhookEnableInput = WebhookEventsInput.partial().openapi("IntegrationWebhookEnableInput");

const SyncInput = z
  .object({
    integrationId: z.string().min(1),
    collection: z.string().min(1).openapi({
      description: "Managed collection slug the rows land in (pull) or come from (push).",
    }),
    // Derived from the service's own list rather than re-typed. A hand-written
    // enum here is a second place a direction has to be added, and the one that
    // silently 422s a request the service would have accepted.
    direction: z
      .enum(SYNC_DIRECTIONS as unknown as [SyncDirection, ...SyncDirection[]])
      .optional()
      .openapi({
        description:
          "`pull` draws rows in from a source (default); `push` mirrors the collection out to a warehouse; " +
          "`inbound` has nothing to poll and exists to receive the provider's webhook deliveries; " +
          "`listing` puts products on sale at a marketplace and writes the verdict back. A `pull` sync " +
          "may ALSO have an endpoint — that is the normal case for a marketplace, and the poll is what repairs " +
          "the deliveries a webhook loses.",
      }),
    matchField: z
      .string()
      .min(1)
      .nullish()
      .openapi({
        description:
          "The collection field a delivery is matched on, for a provider whose webhook updates rows it did " +
          "not create (a carrier's tracking events). Refused for a provider that sends whole records.",
      }),
    settings: z.record(z.string(), z.unknown()).optional().openapi({
      description: "Which spreadsheet / base / database. Keys come from the catalog's `sourceSettings`.",
    }),
    mapping: z.record(z.string(), z.string()).openapi({
      description:
        "Read in the direction of travel: `external field → collection field` on a pull, " +
        "`collection field → external column` on a push. Unmapped keys are dropped.",
    }),
    childMappings: z
      .record(z.string(), ChildMapping)
      .optional()
      .openapi({
        description:
          "Pull only. Where a record's child rows land, keyed by the group name the provider " +
          "returns (e.g. `items` for an order's lines). Children are upserted, never reconciled — " +
          "a line removed at the provider stays in the collection.",
      }),
    categoryField: z
      .string()
      .min(1)
      .nullish()
      .openapi({
        description:
          "Listing only. The product column naming the local category, which the category mapping is keyed by.",
      }),
    outputsMapping: z
      .record(z.string(), z.string())
      .optional()
      .openapi({
        description:
          "Listing only, and read the OTHER way from `mapping`: provider output key → the column a " +
          "marketplace's verdict is written to. Without one a batch would be published and every " +
          "answer discarded.",
      }),
    intervalMinutes: z.number().int().min(0).max(10_080).optional().openapi({
      description: "How often the scheduler runs it. 0 = manual only. Default 60, and 0 for a listing.",
    }),
    enabled: z.boolean().optional(),
  })
  .openapi("IntegrationSyncInput");

/**
 * One local category's answer to what a marketplace demands.
 *
 * `attributes` is keyed by the provider's attribute id and each entry carries
 * exactly one of three answers: a value from the closed set, free text, or the
 * product column to read the value from. The third is what makes a varianter
 * attribute — a size, a colour — describe every unit without the operator
 * typing each one.
 */
const ListingAttributeBindingSchema = z
  .object({
    valueId: z.string().min(1).optional(),
    custom: z.string().min(1).optional(),
    field: z.string().min(1).optional(),
  })
  .openapi("IntegrationListingBinding");

const ListingMapInput = z
  .object({
    localValue: z.string().min(1).openapi({
      description: "The value found in the sync's category field, verbatim.",
    }),
    categoryId: z.string().min(1).openapi({
      description: "The marketplace's own LEAF category id. A parent is refused by the provider.",
    }),
    attributes: z.record(z.string(), ListingAttributeBindingSchema).optional(),
  })
  .openapi("IntegrationListingMapInput");

const ListingMapOut = z
  .object({
    id: z.string(),
    syncId: z.string(),
    localValue: z.string(),
    categoryId: z.string(),
    attributes: z.record(z.string(), ListingAttributeBindingSchema),
    createdAt: z.union([z.string(), z.number()]).nullable(),
    updatedAt: z.union([z.string(), z.number()]).nullable(),
  })
  .openapi("IntegrationListingMap");

const SyncPatch = SyncInput.omit({ integrationId: true, collection: true })
  .partial()
  .openapi("IntegrationSyncPatch");

const IntegrationInput = z
  .object({
    kind: z.enum([...INTEGRATION_KINDS]).openapi({ description: "Provider to connect." }),
    config: z.record(z.string(), z.unknown()).optional().openapi({
      description: "Provider settings; secret fields are encrypted at rest.",
    }),
    events: z
      .array(z.string().min(1))
      .nullish()
      .openapi({ description: "Event patterns (e.g. `posts.created`); null/empty = all events." }),
  })
  .openapi("IntegrationInput");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tags = ["integrations"];

/** Admin REST surface for workspace integrations (Slack/Discord/Datadog/GitHub).
 *  Secrets are encrypted at rest and never returned (masked). */
export const integrationsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/catalog",
      tags,
      summary: "Integration catalog",
      description: "Available providers + their config field schema (for the connect UI).",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: CatalogView }) } } },
        ...errorResponses,
      },
    }),
    (c) =>
      c.json({
        data: {
          kinds: [...INTEGRATION_KINDS],
          fields: INTEGRATION_FIELDS,
          providers: INTEGRATION_CATALOG.map(
            ({ id, label, category, capabilities, oauth, recordPayload }) => ({
              id,
              label,
              category,
              capabilities,
              oauth,
              recordPayload,
            }),
          ),
          oauthRedirectUri: oauthRedirectUri(c.get("ctx").env.APP_URL),
          sourceSettings: SOURCE_SETTING_FIELDS,
          destinationSettings: DESTINATION_SETTING_FIELDS,
          // Only for the sources that return children at all. Absent means a
          // flat record, and the sync dialog offers no line mapping for it.
          sourceChildGroups: SOURCE_CHILD_GROUPS,
          // Only for the destinations with a closed column set. Absent means
          // "free text" — a warehouse's columns are the operator's DDL.
          destinationColumns: DESTINATION_COLUMNS,
          tasks: INTEGRATION_TASKS,
          // Only the providers that call us. Absent means the sync form offers
          // no endpoint, which is the right reading for every provider that
          // only ever answers a request we made.
          webhooks: INTEGRATION_WEBHOOKS,
          // Only the providers that can put a product on sale. Absent means the
          // sync form never offers the direction, which is the right reading for
          // every provider that has no catalog to be listed against.
          listings: INTEGRATION_LISTINGS,
        },
      }),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List connected integrations",
      description: "Admin-only. Lists the active workspace's integrations (secrets masked).",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(IntegrationView) }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      return c.json({ data: await listIntegrations(ctx, tenantId) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Connect (or update) an integration",
      description: "Admin-only. One row per (workspace, kind); secret fields are encrypted at rest.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: IntegrationInput } } } },
      responses: {
        201: { description: "Created", content: { "application/json": { schema: z.object({ data: IntegrationView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const data = await connectIntegration(
        ctx,
        { tenantId, kind: body.kind, config: body.config, events: body.events ?? null },
        ctx.env.AUTH_SECRET,
      );
      await logActivity(c, {
        action: "create",
        collection: "system_integrations",
        itemId: data.id,
        payload: { kind: body.kind },
        response: { data },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Disconnect an integration",
      description: "Admin-only.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await disconnectIntegration(ctx, tenantId, id);
      await logActivity(c, { action: "delete", collection: "system_integrations", itemId: id });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/deliveries",
      tags,
      summary: "Recent delivery attempts",
      description:
        "Admin-only. Newest first. One row per attempt, including queue retries — `status` 0 means the provider " +
        "was misconfigured or unreachable.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).optional().openapi({ description: "Default 50." }),
        }),
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(DeliveryView) }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      return c.json({ data: await listIntegrationDeliveries(ctx, tenantId, id, limit ?? 50) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/resume",
      tags,
      summary: "Resume an auto-disabled integration",
      description:
        "Admin-only. Clears the failure counter and flips `status` back to `connected` after the circuit breaker " +
        "paused the integration. Fix the provider config first, or it will trip again.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: IntegrationView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const data = await resumeIntegration(ctx, tenantId, id);
      if (!data) throw new AppError("NOT_FOUND", "Integration not found");
      await logActivity(c, { action: "update", collection: "system_integrations", itemId: id, payload: { resumed: true } });
      return c.json({ data });
    },
  )
  // ── Source syncs ───────────────────────────────────────────────────────────
  // Registered before `/{id}/…` so the literal `syncs` segment is not eaten by
  // the integration-id parameter.
  .openapi(
    createRoute({
      method: "get",
      path: "/syncs",
      tags,
      summary: "List source syncs",
      description: "Admin-only. Scheduled pulls from source integrations into collections.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          integrationId: z.string().optional().openapi({ description: "Filter to one connection." }),
        }),
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(SyncView) }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { integrationId } = c.req.valid("query");
      return c.json({ data: await listSyncs(c.get("ctx"), tenantId, integrationId) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/syncs",
      tags,
      summary: "Create a source sync",
      description:
        "Admin-only. The collection must be managed (never adopted) and every mapping target must be a " +
        "writable field on it. Pulled rows get a namespaced primary key, so they update in place on re-pull " +
        "and never collide with rows a person created.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: SyncInput } } } },
      responses: {
        201: { description: "Created", content: { "application/json": { schema: z.object({ data: SyncView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const data = await createSync(c.get("ctx"), tenantId, body);
      await logActivity(c, {
        action: "create",
        collection: "system_integration_syncs",
        itemId: data.id,
        payload: { collection: data.collection },
        response: { data },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/syncs/{id}",
      tags,
      summary: "Update a source sync",
      description:
        "Admin-only. Changing `settings` resets the resume cursor — a row offset from one spreadsheet is " +
        "meaningless against another. Re-enabling clears the failure counter.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: SyncPatch } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: SyncView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const data = await updateSync(c.get("ctx"), tenantId, id, c.req.valid("json"));
      await logActivity(c, { action: "update", collection: "system_integration_syncs", itemId: id });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/syncs/{id}",
      tags,
      summary: "Delete a source sync",
      description: "Admin-only. Rows already pulled into the collection stay; only the schedule goes.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await deleteSync(c.get("ctx"), tenantId, id);
      await logActivity(c, { action: "delete", collection: "system_integration_syncs", itemId: id });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/syncs/{id}/webhook",
      tags,
      summary: "Turn on the inbound endpoint",
      description:
        "Admin-only. Mints a URL and a secret this sync will accept deliveries on, and — for the providers " +
        "that have an API for it — registers them at the provider so nothing has to be pasted anywhere. The " +
        "secret is returned ONCE and never again: it is a bearer credential a third party also holds, so a " +
        "field that kept handing it back would put it in a cache, a screenshot and an activity log. Call this " +
        "again to rotate it; the URL stays the same. Registration failing does NOT roll the endpoint back — the " +
        "URL works, and `registrationError` says what to retry.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: WebhookEnableInput } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: WebhookEndpointView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json") ?? {};
      const data = await enableWebhook(c.get("ctx"), tenantId, id, { events: body.events });
      await logActivity(c, {
        action: "update",
        collection: "system_integration_syncs",
        itemId: id,
        // The secret is deliberately absent from what is logged. `data` carries
        // it exactly once, to the caller, and an activity row is the last place
        // a credential a third party also holds should come to rest.
        payload: { webhook: "enabled", events: data.events, registered: data.registered },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/syncs/{id}/webhook",
      tags,
      summary: "Change which events the endpoint accepts",
      description:
        "Admin-only. An empty list means every event the provider declares. Where the provider filters " +
        "server-side (Trendyol's `subscribedStatuses`), it is re-registered so a deselected event stops being " +
        "sent rather than being sent and dropped — which rotates the secret as a side effect, because " +
        "re-registering is the only way to say so.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: WebhookEventsInput } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: SyncView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const { events } = c.req.valid("json");
      const data = await updateWebhookEvents(c.get("ctx"), tenantId, id, events);
      await logActivity(c, {
        action: "update",
        collection: "system_integration_syncs",
        itemId: id,
        payload: { webhookEvents: events },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/syncs/{id}/webhook",
      tags,
      summary: "Turn off the inbound endpoint",
      description:
        "Admin-only. Asks the provider to stop first, but its answer decides nothing — the endpoint is torn " +
        "down either way, because an operator turning off a firehose cannot be blocked by the firehose being " +
        "unreachable. Deliveries to the old URL then resolve to nothing.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await disableWebhook(c.get("ctx"), tenantId, id);
      await logActivity(c, {
        action: "update",
        collection: "system_integration_syncs",
        itemId: id,
        payload: { webhook: "disabled" },
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/syncs/{id}/deliveries",
      tags,
      summary: "Recent inbound deliveries",
      description:
        "Admin-only. Newest first — the whole health story for an endpoint, which is why the sync row records " +
        "none of it separately. `status` distinguishes what actually happened: `applied` wrote rows, " +
        "`unmatched` means no row held the id the delivery named, `filtered` means the endpoint is not " +
        "subscribed to that event, `ignored` was a ping or an event kind we do not read, `duplicate` was a " +
        "provider retrying something already applied, `rejected` did not present the secret, and `failed` was " +
        "ours.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(InboundDeliveryView) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      return c.json({ data: await listDeliveries(c.get("ctx"), tenantId, id) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/syncs/{id}/run",
      tags,
      summary: "Run a source sync now",
      description:
        "Admin-only. Runs inline and reports what landed, rather than enqueuing — this exists so an admin " +
        "can see the first pull succeed or fail with a reason. Bounded to 20 pages / 2000 rows; a longer " +
        "import resumes on the schedule.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              // A listing run reports what it published rather than what it
              // wrote, so the two shapes are offered rather than one pretending
              // to describe both.
              schema: z.object({
                data: z.union([
                  z.object({ written: z.number(), pages: z.number(), complete: z.boolean() }),
                  z.object({
                    sent: z.number(),
                    rejected: z.number(),
                    unmapped: z.number(),
                    batchId: z.string().nullable(),
                  }),
                ]),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      let data: Awaited<ReturnType<typeof runSync>> | Awaited<ReturnType<typeof runListingSync>>;
      try {
        // Dispatched here rather than inside `runSync`, which would have to
        // import the listing runner while the listing runner already imports
        // it — a cycle for the sake of one branch.
        const sync = await getSync(c.get("ctx"), tenantId, id);
        data =
          sync?.direction === "listing"
            ? await runListingSync(c.get("ctx"), tenantId, id)
            : await runSync(c.get("ctx"), tenantId, id);
      } catch (e) {
        // The whole point of running one by hand is to see WHY it fails. A
        // provider's refusal is not an internal error, and reporting it as one
        // buried the message the connector went to trouble to write — the
        // operator saw "Internal server error" while the sync row itself said
        // "reauthorize the connection".
        if (isAppError(e)) throw e;
        throw new AppError("UNAVAILABLE", e instanceof Error ? e.message : String(e));
      }
      await logActivity(c, {
        action: "update",
        collection: "system_integration_syncs",
        itemId: id,
        payload: { ran: true, ...("written" in data ? { written: data.written } : { sent: data.sent }) },
      });
      return c.json({ data });
    },
  )
  // ── Listings ───────────────────────────────────────────────────────────────
  //
  // The taxonomy reads hang off the CONNECTION, not the sync, because an
  // operator browses categories while deciding whether to make a sync at all —
  // and for the providers whose catalog is public they work before a credential
  // has even been pasted. The mapping and the batches hang off the sync, which
  // is what they configure and what they record.
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/listing/categories",
      tags,
      summary: "The marketplace's category tree, flattened",
      description:
        "Admin-only. Every node, with `parentId` and `leaf` — flat rather than nested because the three " +
        "marketplaces that nest it nest it differently, and a searchable picker over a few thousand nodes " +
        "wants a list. A product may only be listed against a leaf.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    parentId: z.string().nullable(),
                    leaf: z.boolean(),
                  }),
                ),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      return c.json({ data: await readListingCategories(c.get("ctx"), tenantId, id) });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/listing/attributes",
      tags,
      summary: "What one category demands of a product",
      description:
        "Admin-only. The attributes the chosen leaf category requires, with their closed value sets and " +
        "the three flags that decide how the form renders one: `required`, `allowCustom`, and `variant` — " +
        "the last meaning two products differing only here are one product with two variants.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({ categoryId: z.string().min(1) }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    required: z.boolean(),
                    allowCustom: z.boolean(),
                    variant: z.boolean(),
                    multiple: z.boolean(),
                    values: z.array(z.object({ id: z.string(), name: z.string() })),
                  }),
                ),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const { categoryId } = c.req.valid("query");
      return c.json({ data: await readListingAttributes(c.get("ctx"), tenantId, id, categoryId) });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/listing/lookup",
      tags,
      summary: "Search a registry a listing has to name",
      description:
        "Admin-only. A brand list is a quarter of a million rows, so it is searched rather than browsed. " +
        "`lookup` must be one the provider declares; an undeclared key is refused rather than passed on.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({
          lookup: z.string().min(1),
          query: z.string().optional(),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  items: z.array(z.object({ id: z.string(), name: z.string() })),
                  cursor: z.string().nullable(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      return c.json({
        data: await searchListingRegistry(c.get("ctx"), tenantId, id, {
          lookup: q.lookup,
          query: q.query ?? "",
          cursor: q.cursor ?? null,
        }),
      });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/syncs/{id}/listing/maps",
      tags,
      summary: "How this sync's local categories are mapped",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(ListingMapOut) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      return c.json({ data: await listListingMaps(c.get("ctx"), tenantId, id) });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/syncs/{id}/listing/maps",
      tags,
      summary: "Map one local category, or re-map it",
      description:
        "Admin-only. An upsert keyed on the local value: two operators mapping the same category at once " +
        "converge on one row rather than racing. `attributes` answers what the chosen category demands — " +
        "a fixed value id, free text, or the product column to read the value from.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: ListingMapInput } } },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: ListingMapOut }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const data = await upsertListingMap(c.get("ctx"), tenantId, { syncId: id, ...body });
      await logActivity(c, {
        action: "update",
        collection: "system_integration_syncs",
        itemId: id,
        payload: { mapped: body.localValue, to: body.categoryId },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/syncs/{id}/listing/maps/{mapId}",
      tags,
      summary: "Unmap a local category",
      description:
        "Admin-only. Products in it are skipped by the next run rather than published uncategorised, and " +
        "the run reports how many.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string(), mapId: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id, mapId } = c.req.valid("param");
      await deleteListingMap(c.get("ctx"), tenantId, mapId);
      await logActivity(c, {
        action: "update",
        collection: "system_integration_syncs",
        itemId: id,
        payload: { unmapped: mapId },
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/syncs/{id}/listing/batches",
      tags,
      summary: "What this sync published, and what came back",
      description:
        "Admin-only. Newest first. A batch stays `open` until the marketplace has ruled on every unit in " +
        "it — which can take hours — so `pendingCount` is what an operator watches. The barcodes it " +
        "carried are deliberately not returned: that is the payload again in another shape.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(
                  z.object({
                    id: z.string(),
                    batchId: z.string(),
                    status: z.string(),
                    unitCount: z.number(),
                    pendingCount: z.number(),
                    error: z.string().nullable(),
                    createdAt: z.union([z.string(), z.number()]).nullable(),
                    resolvedAt: z.union([z.string(), z.number()]).nullable(),
                  }),
                ),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      return c.json({ data: await listListingBatches(c.get("ctx"), tenantId, id) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/tasks/{task}",
      tags,
      summary: "Run a task against one row",
      description:
        "Admin-only. A task acts on a SINGLE row at the provider and writes what came back onto it — " +
        "booking a shipment and receiving a tracking number and a label is the shape. Unlike a sync this is " +
        "invoked deliberately, never scheduled, and runs at most ONCE per row: a second call returns the " +
        "first run's outputs rather than acting again, because the effect at the provider costs money. Pass " +
        "`force: true` to deliberately re-run one that already succeeded. `outputMapping` says which of the " +
        "task's declared outputs land on which collection fields; an undeclared output or a non-writable " +
        "target is refused rather than silently dropped.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string(), task: z.string() }),
        body: {
          content: { "application/json": { schema: TaskRunInputSchema } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  status: z.enum(["succeeded", "skipped"]),
                  outputs: z.record(z.string(), z.unknown()),
                  artifactKey: z.string().nullable(),
                  reused: z.boolean(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id, task } = c.req.valid("param");
      const body = c.req.valid("json");
      let data: Awaited<ReturnType<typeof runTask>>;
      try {
        data = await runTask(c.get("ctx"), tenantId, { integrationId: id, task, ...body });
      } catch (e) {
        // Same reasoning as running a sync by hand: an operator invoking a task
        // is doing it to see why it fails, and a provider's refusal reported as
        // an internal error buries the only message worth reading.
        if (isAppError(e)) throw e;
        throw new AppError("UNAVAILABLE", e instanceof Error ? e.message : String(e));
      }
      await logActivity(c, {
        action: "update",
        collection: "system_integration_tasks",
        itemId: `${id}:${task}:${body.itemId}`,
        payload: { status: data.status, reused: data.reused },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/task-runs",
      tags,
      summary: "Task runs for one row",
      description:
        "Admin-only. What has already been done to this row and what it produced — which orders have a " +
        "label, and which are still waiting.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({ collection: z.string().min(1), itemId: z.string().min(1) }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(TaskRunView) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { collection, itemId } = c.req.valid("query");
      const data = await listTaskRuns(c.get("ctx"), tenantId, { collection, itemId });
      return c.json({ data });
    },
  )
  // ── OAuth connect ──────────────────────────────────────────────────────────
  // Two legs. `authorize` is a POST because it writes a single-use state row;
  // the callback has to be a GET because the provider redirects a browser to it.
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/oauth/authorize",
      tags,
      summary: "Start an OAuth connect flow",
      description:
        "Admin-only. Returns the provider URL to send the admin to. Requires the integration's `clientId` and " +
        "`clientSecret` to be saved first — backlex is self-hostable, so each workspace brings its own OAuth app. " +
        "The returned link is single-use and expires in 10 minutes.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.object({ url: z.string() }) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const userId = c.get("auth").userId as string;
      const { id } = c.req.valid("param");
      const data = await beginOAuth(ctx, { tenantId, userId, integrationId: id });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/oauth/callback",
      tags,
      summary: "OAuth redirect target",
      description:
        "Where the provider sends the admin back to. Always redirects into the admin UI rather than answering " +
        "with JSON, because the caller is a browser mid-navigation. Not called directly.",
      request: {
        // Providers add their own parameters here (QuickBooks returns the
        // company id as `realmId`), so the schema is permissive and the service
        // keeps only what the provider's descriptor named.
        query: z
          .object({
            code: z.string().optional(),
            state: z.string().optional(),
            error: z.string().optional(),
          })
          .catchall(z.string()),
      },
      responses: {
        302: { description: "Redirect back to the admin integrations page" },
        ...errorResponses,
      },
    }),
    async (c) => {
      // A fixed relative path with a fixed set of status slugs. Nothing the
      // provider sent is echoed into the destination, so this cannot be turned
      // into an open redirect or a reflection sink.
      const back = (status: string) => c.redirect(`/integrations?oauth=${status}`, 302);

      const auth = c.get("auth");
      if (!auth?.userId || !auth.roles?.includes(SYSTEM_ROLES.admin) || !auth.tenantId) {
        return back("signed_out");
      }
      const { code, state, error } = c.req.valid("query");
      // The provider reports a declined consent screen this way; it is the
      // normal "user clicked Cancel" path, not a failure worth logging as one.
      if (error || !code || !state) return back("denied");

      try {
        const { kind } = await completeOAuth(c.get("ctx"), {
          state,
          code,
          tenantId: auth.tenantId,
          userId: auth.userId,
          query: Object.fromEntries(new URL(c.req.url).searchParams),
        });
        await logActivity(c, {
          action: "update",
          collection: "system_integrations",
          payload: { kind, oauth: "connected" },
        });
        return back("connected");
      } catch {
        // Swallowed on purpose: the reasons completeOAuth distinguishes
        // (unknown state, wrong session, failed exchange) are exactly the
        // reasons an attacker probing this endpoint would want told apart.
        return back("failed");
      }
    },
  );
