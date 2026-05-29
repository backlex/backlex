import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { fireDelivery, listDeliveries, retryDelivery } from "../services/webhooks";
import { logActivity } from "../services/activity";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.webhooks : sqlite.schema.webhooks;

const WebhookInput = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    events: z.array(z.string().min(1)).min(1).openapi({
      description: "Event patterns this hook subscribes to (e.g. `items.posts.created`).",
    }),
    headers: z.record(z.string(), z.string()).nullish().openapi({
      description: "Custom request headers sent on every delivery.",
    }),
    secret: z.string().optional().openapi({
      description: "Used to sign deliveries (`X-Workeros-Signature` HMAC-SHA256).",
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
    secret: z.string().nullable(),
    active: z.boolean(),
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

export const webhooksRoutes = new OpenAPIHono<AppBindings>()
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
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any).select().from(t).where(eq(t.tenantId, tenantId));
      return c.json({ data: rows });
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
      const t = tableFor(ctx.dialect);
      const id = crypto.randomUUID();
      await (ctx.db as any).insert(t).values({
        id,
        tenantId,
        name: body.name,
        url: body.url,
        events: body.events,
        headers: body.headers ?? null,
        secret: body.secret ?? null,
        active: body.active ?? true,
      });
      const created = { id, ...body, active: body.active ?? true };
      await logActivity(c, {
        action: "create",
        collection: "system_webhooks",
        itemId: id,
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
      const limit = Number(c.req.query("limit") ?? "50");
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
      const t = tableFor(ctx.dialect);
      await (ctx.db as any)
        .update(t)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.url !== undefined ? { url: body.url } : {}),
          ...(body.events !== undefined ? { events: body.events } : {}),
          ...(body.headers !== undefined ? { headers: body.headers } : {}),
          ...(body.secret !== undefined ? { secret: body.secret } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
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
      const t = tableFor(ctx.dialect);
      await (ctx.db as any)
        .delete(t)
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
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
      const t = tableFor(ctx.dialect);
      const hook = (await (ctx.db as any)
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
        .limit(1)) as {
          id: string;
          name: string;
          url: string;
          secret: string | null;
          events: string[];
          headers: Record<string, string> | null;
        }[];
      const h = hook[0];
      if (!h) throw new AppError("NOT_FOUND", "Webhook not found");
      const payload = {
        type: "webhook.test",
        data: { hookId: h.id, ts: new Date().toISOString() },
      };
      const r = await fireDelivery(ctx, h, "webhook.test", payload);
      await logActivity(c, {
        action: "test",
        collection: "system_webhooks",
        itemId: h.id,
        payload: { status: r?.status, error: r?.error },
        response: { data: r },
      });
      return c.json({ data: r });
    },
  );
