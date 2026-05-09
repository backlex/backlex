import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AppError, OperationsSchema, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { runFlowById } from "../services/flows";

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

export const flowsRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any).select().from(t);
    return c.json({ data: rows });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const body = Input.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t).values({
      id,
      name: body.name,
      trigger: body.trigger,
      operations: body.operations,
      active: body.active ?? true,
    });
    return c.json({ data: { id, ...body, active: body.active ?? true } }, 201);
  })
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
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
      .where(eq(t.id, c.req.param("id")));
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    await (ctx.db as any).delete(t).where(eq(t.id, c.req.param("id")));
    return c.json({ ok: true });
  })
  .post("/:id/run", async (c) => {
    // Manual trigger — admin invokes a flow with an arbitrary input payload.
    // Any flow type can be run this way; cron + event flows are independently
    // dispatched, so this is purely on-demand.
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    await runFlowById(ctx, id, body, {
      userId: auth.userId,
      email: auth.email,
      roles: auth.roles,
    });
    return c.json({ ok: true });
  });
