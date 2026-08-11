import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, isAppError, SYSTEM_ROLES } from "@backlex/core";
import {
  INTEGRATION_CATALOG,
  INTEGRATION_FIELDS,
  INTEGRATION_KINDS,
  DESTINATION_COLUMNS,
  DESTINATION_SETTING_FIELDS,
  INTEGRATION_TASKS,
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
  listSyncs,
  runSync,
  updateSync,
} from "../services/integration-syncs";
import { listTaskRuns, runTask } from "../services/integration-tasks";
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
    createdAt: z.union([z.number(), z.date()]).nullable(),
  })
  .openapi("IntegrationSync");

const SyncInput = z
  .object({
    integrationId: z.string().min(1),
    collection: z.string().min(1).openapi({
      description: "Managed collection slug the rows land in (pull) or come from (push).",
    }),
    direction: z.enum(["pull", "push"]).optional().openapi({
      description:
        "`pull` draws rows in from a source (default); `push` mirrors the collection out to a warehouse.",
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
    intervalMinutes: z.number().int().min(0).max(10_080).optional().openapi({
      description: "How often the scheduler runs it. 0 = manual only. Default 60.",
    }),
    enabled: z.boolean().optional(),
  })
  .openapi("IntegrationSyncInput");

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
              schema: z.object({
                data: z.object({ written: z.number(), pages: z.number(), complete: z.boolean() }),
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
      let data: Awaited<ReturnType<typeof runSync>>;
      try {
        data = await runSync(c.get("ctx"), tenantId, id);
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
        payload: { ran: true, written: data.written },
      });
      return c.json({ data });
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
