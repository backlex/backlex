import { Hono } from "hono";
import { and, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { FILES_COLLECTION } from "./storage";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.folders : sqlite.schema.folders;

const Input = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
});

const filesPerm = () => FILES_COLLECTION;

export const foldersRoutes = new Hono<AppBindings>()
  .get("/", requirePermission(filesPerm, "read"), async (c) => {
    const ctx = c.get("ctx");
    const perm = c.get("permission");
    const t = tableFor(ctx.dialect);
    const parentId = c.req.query("parentId") ?? null;

    const conds: SQL[] = [];
    if (perm.whereSql) conds.push(perm.whereSql);
    if (parentId === "root" || parentId === null) {
      // Drizzle's eq with null produces "IS NULL"
      // For both dialects, use raw SQL
    }

    let qb = (ctx.db as any).select().from(t);
    if (conds.length) qb = qb.where(conds.length === 1 ? conds[0] : and(...conds));
    const rows = await qb;
    return c.json({ data: rows });
  })
  .post("/", requirePermission(filesPerm, "create"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = Input.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t).values({
      id,
      name: body.name,
      parentId: body.parentId ?? null,
      ownerId: auth.userId,
    });
    return c.json(
      {
        data: {
          id,
          name: body.name,
          parentId: body.parentId ?? null,
          ownerId: auth.userId,
        },
      },
      201,
    );
  })
  .patch("/:id", requirePermission(filesPerm, "update"), async (c) => {
    const ctx = c.get("ctx");
    const perm = c.get("permission");
    const body = Input.partial().parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const conds: SQL[] = [eq(t.id, c.req.param("id"))];
    if (perm.whereSql) conds.push(perm.whereSql);
    const existing = await (ctx.db as any)
      .select()
      .from(t)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Folder not found");
    await (ctx.db as any)
      .update(t)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.id, c.req.param("id")));
    return c.json({ ok: true });
  })
  .delete("/:id", requirePermission(filesPerm, "delete"), async (c) => {
    const ctx = c.get("ctx");
    const perm = c.get("permission");
    const t = tableFor(ctx.dialect);
    const conds: SQL[] = [eq(t.id, c.req.param("id"))];
    if (perm.whereSql) conds.push(perm.whereSql);
    const existing = await (ctx.db as any)
      .select({ id: t.id })
      .from(t)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Folder not found");
    await (ctx.db as any).delete(t).where(eq(t.id, c.req.param("id")));
    return c.json({ ok: true });
  });
