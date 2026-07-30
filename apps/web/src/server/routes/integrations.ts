import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import {
  INTEGRATION_CATALOG,
  INTEGRATION_FIELDS,
  INTEGRATION_KINDS,
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
      }),
    ),
    /** The exact URI to register with each OAuth provider. Deriving it in the
     *  UI would get it wrong behind a proxy; the server knows its own APP_URL. */
    oauthRedirectUri: z.string(),
    /** Per-sync settings each source provider needs, keyed by kind. */
    sourceSettings: z.record(z.string(), z.unknown()),
  })
  .openapi("IntegrationCatalog");

const SyncView = z
  .object({
    id: z.string(),
    integrationId: z.string(),
    collection: z.string(),
    settings: z.record(z.string(), z.unknown()),
    mapping: z.record(z.string(), z.string()),
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
    collection: z.string().min(1).openapi({ description: "Managed collection slug the rows land in." }),
    settings: z.record(z.string(), z.unknown()).optional().openapi({
      description: "Which spreadsheet / base / database. Keys come from the catalog's `sourceSettings`.",
    }),
    mapping: z.record(z.string(), z.string()).openapi({
      description: "External field name → collection field name. Unmapped external fields are dropped.",
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
          providers: INTEGRATION_CATALOG.map(({ id, label, category, capabilities, oauth }) => ({
            id,
            label,
            category,
            capabilities,
            oauth,
          })),
          oauthRedirectUri: oauthRedirectUri(c.get("ctx").env.APP_URL),
          sourceSettings: SOURCE_SETTING_FIELDS,
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
      const data = await runSync(c.get("ctx"), tenantId, id);
      await logActivity(c, {
        action: "update",
        collection: "system_integration_syncs",
        itemId: id,
        payload: { ran: true, written: data.written },
      });
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
        query: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
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
