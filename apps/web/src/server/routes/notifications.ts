import { Hono } from "hono";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.notifications : sqlite.schema.notifications;

const Input = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  url: z.string().optional(),
  /** When omitted, the notification is broadcast (userId=null). */
  userId: z.string().nullable().optional(),
});

/**
 * In-app notifications. Each row targets a userId (or null = broadcast).
 * `flow_id` is filled by the flow `notification` op (which uses an
 * internal write path); admin POST here is for ad-hoc test or manual
 * admin actions.
 */
export const notificationsRoutes = new Hono<AppBindings>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const onlyUnread = c.req.query("unread") === "1";
    const limit = Math.min(200, Number(c.req.query("limit") ?? "50"));
    const myConds = auth.userId
      ? or(eq(t.userId, auth.userId), isNull(t.userId))
      : isNull(t.userId);
    const where = onlyUnread ? and(myConds, isNull(t.readAt)) : myConds;
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.createdAt))
      .limit(limit);
    return c.json({ data: rows });
  })
  .get("/_unread-count", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const where = and(
      auth.userId
        ? or(eq(t.userId, auth.userId), isNull(t.userId))
        : isNull(t.userId),
      isNull(t.readAt),
    );
    const r = await (ctx.db as any)
      .select({ count: sql<number>`count(*)` })
      .from(t)
      .where(where);
    return c.json({ data: { count: Number(r[0]?.count ?? 0) } });
  })
  .post("/", async (c) => {
    // Admin-only ad-hoc post — anyone signed in can write only to themselves.
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = Input.parse(await c.req.json());
    const isAdmin = auth.roles.includes("admin");
    if (!isAdmin && body.userId && body.userId !== auth.userId) {
      throw new AppError(
        "FORBIDDEN",
        "Non-admins can only notify themselves",
      );
    }
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    const now = ctx.dialect === "pg" ? new Date() : Date.now();
    await (ctx.db as any).insert(t).values({
      id,
      userId: body.userId ?? auth.userId ?? null,
      title: body.title,
      body: body.body ?? null,
      url: body.url ?? null,
      flowId: null,
      readAt: null,
      createdAt: now,
    });
    return c.json({ data: { id } }, 201);
  })
  .post("/:id/read", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    const now = ctx.dialect === "pg" ? new Date() : Date.now();
    await (ctx.db as any)
      .update(t)
      .set({ readAt: now })
      .where(
        and(
          eq(t.id, id),
          auth.userId
            ? or(eq(t.userId, auth.userId), isNull(t.userId))
            : isNull(t.userId),
        ),
      );
    return c.json({ ok: true });
  })
  .post("/_read-all", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const now = ctx.dialect === "pg" ? new Date() : Date.now();
    await (ctx.db as any)
      .update(t)
      .set({ readAt: now })
      .where(
        and(
          auth.userId
            ? or(eq(t.userId, auth.userId), isNull(t.userId))
            : isNull(t.userId),
          isNull(t.readAt),
        ),
      );
    return c.json({ ok: true });
  });
