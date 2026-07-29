import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import { INTEGRATION_CATALOG, INTEGRATION_FIELDS, INTEGRATION_KINDS } from "@backlex/integrations";
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
      }),
    ),
  })
  .openapi("IntegrationCatalog");

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
          providers: INTEGRATION_CATALOG.map(({ id, label, category, capabilities }) => ({
            id,
            label,
            category,
            capabilities,
          })),
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
  );
