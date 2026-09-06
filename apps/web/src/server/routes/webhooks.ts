import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  retryDelivery,
  testWebhook,
  updateWebhook,
} from "../services/webhooks";
import { logActivity } from "../services/activity";
import { parsePagination } from "../lib/pagination";
import { SECURITY, OkSchema, errorResponses, httpUrl } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";

const WebhookInput = z
  .object({
    name: z.string().min(1),
    url: httpUrl(),
    events: z.array(z.string().min(1)).min(1).openapi({
      description: "Event patterns this hook subscribes to (e.g. `items.posts.created`).",
    }),
    headers: z.record(z.string(), z.string()).nullish().openapi({
      description: "Custom request headers sent on every delivery.",
    }),
    payloadFields: z.array(z.string().min(1)).max(200).nullish().openapi({
      description:
        "Allow-list of top-level `data` keys this hook may carry. Omit, null, " +
        "or empty to send the whole row. An allow-list, so a field added to the " +
        "collection later never starts flowing to an endpoint configured " +
        "before it existed.",
    }),
    secret: z.string().optional().openapi({
      description: "Used to sign deliveries (`X-Backlex-Signature` HMAC-SHA256).",
    }),
    active: z.boolean().optional(),
  })
  .openapi("WebhookInput");

const WebhookRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    headers: z.record(z.string(), z.string()).nullable(),
    payloadFields: z.array(z.string()).nullable().optional(),
    // Presence only. The plaintext secret is reachable through
    // `GET /api/webhooks/{id}` — an operator legitimately re-reads it to
    // configure the receiving endpoint, and the admin's "Show" button does
    // exactly that. What it must not do is ride on the LIST, which is the
    // response an SDK caller logs, pastes into an issue, or hands to an agent.
    // `/api/admin/auth-hooks` reports presence the same way.
    hasSecret: z.boolean(),
    active: z.boolean(),
    consecutiveFailures: z.number().int().nullable().optional().openapi({
      description: "Consecutive failed deliveries since the last success.",
    }),
    lastFailureAt: z.unknown().optional(),
    disabledReason: z.string().nullable().optional().openapi({
      description:
        "Set when the breaker auto-disabled this hook after repeated failures; null otherwise.",
    }),
  })
  .openapi("WebhookRow");

const DeliveryRow = z
  .object({
    id: z.string(),
    webhookId: z.string(),
    event: z.string(),
    status: z.number().int().nullable(),
    error: z.string().nullable().optional(),
    payload: z.unknown().optional(),
    response: z.unknown().optional(),
    createdAt: z.unknown().optional(),
  })
  .openapi("WebhookDelivery");

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

const tags = ["webhooks"];

export const webhooksRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List webhooks",
      description: "Admin-only. Lists every webhook in the active workspace.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(WebhookRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const rows = (await listWebhooks(ctx, tenantId)) as any[];
      // Projected, not spread: a future column that happens to hold a
      // credential would otherwise join the list response by default.
      const data = rows.map(({ secret, ...rest }: Record<string, unknown>) => ({
        ...rest,
        hasSecret: typeof secret === "string" && secret.length > 0,
      }));
      return c.json({ data } as never);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create webhook",
      description: "Admin-only.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: WebhookInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": { schema: z.any() },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const created = await createWebhook(ctx, tenantId, body);
      await logActivity(c, {
        action: "create",
        collection: "system_webhooks",
        itemId: created.id as string,
        payload: { name: body.name, url: body.url },
        response: { data: created },
      });
      return c.json({ data: created }, 201);
    },
  )
  /** List recent deliveries — optional `?webhookId=…` and `?limit=N`. */
  .openapi(
    createRoute({
      method: "get",
      path: "/_deliveries",
      tags,
      summary: "List recent deliveries",
      description: "Admin-only. Optional `webhookId` filter; default limit 50.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          webhookId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(DeliveryRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const webhookId = c.req.query("webhookId") || undefined;
      const { limit } = parsePagination(c);
      const data = await listDeliveries(ctx, { webhookId, limit, tenantId });
      return c.json({ data });
    },
  )
  /** Replay a single past delivery with the original headers + signature. */
  .openapi(
    createRoute({
      method: "post",
      path: "/_deliveries/{id}/retry",
      tags,
      summary: "Retry delivery",
      description:
        "Admin-only. Replays a past delivery with the original headers + signature.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.any() },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const out = await retryDelivery(ctx, id, tenantId);
      if (!out)
        throw new AppError("NOT_FOUND", "Delivery (or its hook) is gone");
      return c.json({ data: out });
    },
  )
  // Registered AFTER `/_deliveries`. Hono matches in declaration order, so a
  // `/{id}` placed above it swallows `/_deliveries` as an id and the delivery
  // log 404s — which is exactly what happened when this route was first added.
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags,
      summary: "Read one webhook, including its signing secret",
      description:
        "Admin-only. This is the ONE surface that returns the plaintext signing secret — an " +
        "operator re-reads it to configure the receiving endpoint. The list deliberately does " +
        "not, because a list response is what gets logged and pasted around.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: WebhookRow.extend({ secret: z.string().nullable() }) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const rows = (await listWebhooks(ctx, tenantId)) as any[];
      const row = rows.find((r) => r.id === id);
      if (!row) throw new AppError("NOT_FOUND", "Webhook not found");
      return c.json({
        data: { ...row, hasSecret: typeof row.secret === "string" && row.secret.length > 0 },
      });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update webhook",
      description: "Admin-only. Partial update.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: WebhookInput.partial() } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const { id } = c.req.valid("param");
      await updateWebhook(ctx, tenantId, id, body);
      await logActivity(c, {
        action: "update",
        collection: "system_webhooks",
        itemId: id,
        payload: body,
        response: { ok: true },
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete webhook",
      description: "Admin-only.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await deleteWebhook(ctx, tenantId, id);
      await logActivity(c, {
        action: "delete",
        collection: "system_webhooks",
        itemId: id,
        response: { ok: true },
      });
      return c.json({ ok: true });
    },
  )
  /**
   * Fire a synthetic `webhook.test` event at the given hook so the operator
   * can confirm DNS/auth without waiting for a real model event. The hook's
   * configured signature + headers are honoured; the test payload mirrors a
   * real delivery so the receiver's parser doesn't have to special-case it.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/test",
      tags,
      summary: "Fire test delivery",
      description:
        "Admin-only. Sends a synthetic `webhook.test` event so the operator can confirm DNS/auth without waiting for a real event.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.any() },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const r = await testWebhook(ctx, tenantId, id);
      await logActivity(c, {
        action: "test",
        collection: "system_webhooks",
        itemId: id,
        payload: { status: r?.status, error: r?.error },
        response: { data: r },
      });
      return c.json({ data: r });
    },
  );
