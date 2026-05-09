import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.comments : sqlite.schema.comments;

const Input = z.object({
  collection: z.string().min(1),
  itemId: z.string().min(1),
  body: z.string().min(1).max(4000),
});

/**
 * Per-item discussion thread. Each comment is bound to (collection, itemId)
 * and stored separately from the dynamic `c_<slug>` table — admins can
 * reuse comments across migrations without ALTERing user collections.
 *
 * Permissions are deliberately loose for now: any signed-in user can read +
 * write; only authors and admins can delete. When the permission DSL gains
 * a richer "subject" notion this should fold into it.
 */
export const commentsRoutes = new Hono<AppBindings>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const collection = c.req.query("collection");
    const itemId = c.req.query("itemId");
    if (!collection || !itemId) {
      throw new AppError(
        "VALIDATION",
        "?collection=<slug>&itemId=<id> are required",
      );
    }
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.collection, collection), eq(t.itemId, itemId)))
      .orderBy(desc(t.createdAt));
    return c.json({ data: rows });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = Input.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    const now = ctx.dialect === "pg" ? new Date() : Date.now();
    await (ctx.db as any).insert(t).values({
      id,
      collection: body.collection,
      itemId: body.itemId,
      userId: auth.userId,
      body: body.body,
      createdAt: now,
    });
    return c.json(
      { data: { id, ...body, userId: auth.userId, createdAt: now } },
      201,
    );
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AppError("NOT_FOUND", "Comment not found");
    const isAdmin = auth.roles.includes("admin");
    if (!isAdmin && row.userId !== auth.userId) {
      throw new AppError("FORBIDDEN", "Only the author or admin can delete");
    }
    await (ctx.db as any).delete(t).where(eq(t.id, id));
    return c.json({ ok: true });
  });
