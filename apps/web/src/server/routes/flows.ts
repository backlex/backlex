import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AppError, OperationsSchema, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { runFlowById } from "../services/flows";
import { logActivity } from "../services/activity";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;

const Input = z.object({
  name: z.string().min(1),
  trigger: z.string().min(1),
  operations: OperationsSchema,
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

export const flowsRoutes = new Hono<AppBindings>()
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
      trigger: body.trigger,
      operations: body.operations,
      active: body.active ?? true,
    });
    await logActivity(c, { action: "create", collection: "system_flows", itemId: id, payload: { name: body.name, trigger: body.trigger } });
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
        ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
        ...(body.operations !== undefined ? { operations: body.operations } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(and(eq(t.id, c.req.param("id")), eq(t.tenantId, tenantId)));
    await logActivity(c, { action: "update", collection: "system_flows", itemId: c.req.param("id"), payload: body });
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .delete(t)
      .where(and(eq(t.id, c.req.param("id")), eq(t.tenantId, tenantId)));
    await logActivity(c, { action: "delete", collection: "system_flows", itemId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .post("/:id/run", async (c) => {
    // Manual trigger — admin invokes a flow with an arbitrary input payload.
    // Any flow type can be run this way; cron + event flows are independently
    // dispatched, so this is purely on-demand.
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    // Verify the flow belongs to the active workspace before running —
    // runFlowById doesn't tenant-check on its own.
    const t = tableFor(ctx.dialect);
    const own = await (ctx.db as any)
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
      .limit(1);
    if (!own[0]) throw new AppError("NOT_FOUND", "Flow not found");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    await runFlowById(ctx, id, body, {
      userId: auth.userId,
      email: auth.email,
      roles: auth.roles,
    });
    await logActivity(c, { action: "run", collection: "system_flows", itemId: id });
    return c.json({ ok: true });
  });
