import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { listDeliveries, retryDelivery } from "../services/webhooks";
import { logActivity } from "../services/activity";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.webhooks : sqlite.schema.webhooks;

const Input = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  headers: z.record(z.string()).optional(),
  secret: z.string().optional(),
  active: z.boolean().optional(),
});

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

export const webhooksRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any).select().from(t).where(eq(t.tenantId, tenantId));
    return c.json({ data: rows });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const body = Input.parse(await c.req.json());
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
    await logActivity(c, { action: "create", collection: "system_webhooks", itemId: id, payload: { name: body.name, url: body.url } });
    return c.json({ data: { id, ...body, active: body.active ?? true } }, 201);
  })
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const body = Input.partial().parse(await c.req.json());
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
      .where(and(eq(t.id, c.req.param("id")), eq(t.tenantId, tenantId)));
    await logActivity(c, { action: "update", collection: "system_webhooks", itemId: c.req.param("id"), payload: body });
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .delete(t)
      .where(and(eq(t.id, c.req.param("id")), eq(t.tenantId, tenantId)));
    await logActivity(c, { action: "delete", collection: "system_webhooks", itemId: c.req.param("id") });
    return c.json({ ok: true });
  })
  /** List recent deliveries — optional `?webhookId=…` and `?limit=N`. */
  .get("/_deliveries", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const webhookId = c.req.query("webhookId") || undefined;
    const limit = Number(c.req.query("limit") ?? "50");
    const data = await listDeliveries(ctx, { webhookId, limit, tenantId });
    return c.json({ data });
  })
  /** Replay a single past delivery with the original headers + signature. */
  .post("/_deliveries/:id/retry", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const out = await retryDelivery(ctx, c.req.param("id"), tenantId);
    if (!out)
      throw new AppError("NOT_FOUND", "Delivery (or its hook) is gone");
    return c.json({ data: out });
  })
  /**
   * Fire a synthetic `webhook.test` event at the given hook so the operator
   * can confirm DNS/auth without waiting for a real model event. The hook's
   * configured signature + headers are honoured; the test payload mirrors a
   * real delivery so the receiver's parser doesn't have to special-case it.
   */
  .post("/:id/test", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const hook = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.id, c.req.param("id")), eq(t.tenantId, tenantId)))
      .limit(1)) as { id: string; name: string; url: string; secret: string | null; events: string[]; headers: Record<string, string> | null }[];
    const h = hook[0];
    if (!h) throw new AppError("NOT_FOUND", "Webhook not found");
    const { fireDelivery } = await import("../services/webhooks");
    const payload = {
      type: "webhook.test",
      data: { hookId: h.id, ts: new Date().toISOString() },
    };
    const r = await fireDelivery(ctx, h, "webhook.test", payload);
    await logActivity(c, { action: "test", collection: "system_webhooks", itemId: h.id, payload: { status: r?.status, error: r?.error } });
    return c.json({ data: r });
  });
