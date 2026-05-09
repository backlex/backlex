import { Hono } from "hono";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.activity : sqlite.schema.activity;

export const activityRoutes = new Hono<AppBindings>()
  .get("/", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    const t = tableFor(ctx.dialect);
    const limit = Math.min(
      200,
      Math.max(1, Number(c.req.query("limit") ?? 50) || 50),
    );
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const collection = c.req.query("collection");
    const itemId = c.req.query("itemId");

    const conds: SQL[] = [];
    if (!isAdmin) {
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Sign in required");
      conds.push(eq(t.userId, auth.userId));
    }
    if (collection) conds.push(eq(t.collection, collection));
    if (itemId) conds.push(eq(t.itemId, itemId));

    let qb = (ctx.db as any).select().from(t);
    if (conds.length) qb = qb.where(conds.length === 1 ? conds[0] : and(...conds));
    const rows = await qb.orderBy(desc(t.createdAt)).limit(limit).offset(offset);

    return c.json({ data: rows, limit, offset });
  });
