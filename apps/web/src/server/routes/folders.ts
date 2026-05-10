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

const requireTenantId = (auth: { tenantId?: string | null }): string => {
  if (!auth.tenantId) {
    throw new AppError("VALIDATION", "Active tenant is required for folder operations");
  }
  return auth.tenantId;
};

export const foldersRoutes = new Hono<AppBindings>()
  .get("/", requirePermission(filesPerm, "read"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const t = tableFor(ctx.dialect);

    const conds: SQL[] = [eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);

    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(and(...conds));
    return c.json({ data: rows });
  })
  .post("/", requirePermission(filesPerm, "create"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenantId(auth);
    const body = Input.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t).values({
      id,
      name: body.name,
      parentId: body.parentId ?? null,
      ownerId: auth.userId,
      tenantId,
    });
    return c.json(
      {
        data: {
          id,
          name: body.name,
          parentId: body.parentId ?? null,
          ownerId: auth.userId,
          tenantId,
        },
      },
      201,
    );
  })
  .patch("/:id", requirePermission(filesPerm, "update"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const body = Input.partial().parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    const conds: SQL[] = [eq(t.id, id), eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const existing = await (ctx.db as any)
      .select()
      .from(t)
      .where(and(...conds))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Folder not found");
    await (ctx.db as any)
      .update(t)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
    return c.json({ ok: true });
  })
  .delete("/:id", requirePermission(filesPerm, "delete"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    const conds: SQL[] = [eq(t.id, id), eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const existing = await (ctx.db as any)
      .select({ id: t.id })
      .from(t)
      .where(and(...conds))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Folder not found");
    await (ctx.db as any)
      .delete(t)
      .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
    return c.json({ ok: true });
  });
