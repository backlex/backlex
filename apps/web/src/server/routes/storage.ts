import { Hono } from "hono";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";

export const FILES_COLLECTION = "system_files";

const filesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.files : sqlite.schema.files;

const filesCollection = () => FILES_COLLECTION;

interface FileRow {
  key: string;
  folderId: string | null;
  ownerId: string | null;
  size: number;
  contentType: string | null;
  createdAt: Date | number;
}

export const storageRoutes = new Hono<AppBindings>()
  .get("/", requirePermission(filesCollection, "read"), async (c) => {
    const ctx = c.get("ctx");
    const perm = c.get("permission");
    const t = filesTable(ctx.dialect);
    const prefix = c.req.query("prefix") ?? "";

    const conds: SQL[] = [];
    if (perm.whereSql) conds.push(perm.whereSql);
    if (prefix) conds.push(sql`${sql.identifier("key")} LIKE ${`${prefix}%`}`);

    let qb = (ctx.db as any).select().from(t);
    if (conds.length) qb = qb.where(conds.length === 1 ? conds[0] : and(...conds));
    const rows = (await qb) as FileRow[];

    return c.json({
      data: rows.map((r) => ({
        key: r.key,
        folderId: r.folderId,
        size: r.size,
        contentType: r.contentType ?? undefined,
        ownerId: r.ownerId,
        uploadedAt:
          r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : new Date(r.createdAt).toISOString(),
      })),
    });
  })
  .put("/:key{.+}", requirePermission(filesCollection, "create"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const key = c.req.param("key");
    const contentType = c.req.header("content-type") ?? undefined;
    const folderId = c.req.query("folderId") ?? null;
    const body = c.req.raw.body;
    if (!body) throw new AppError("BAD_REQUEST", "Empty body");
    const obj = await ctx.storage.put({ key, body, contentType });
    const t = filesTable(ctx.dialect);
    await (ctx.db as any)
      .insert(t)
      .values({
        key,
        folderId,
        ownerId: auth.userId,
        size: obj.size,
        contentType: obj.contentType ?? null,
      })
      .onConflictDoUpdate({
        target: t.key,
        set: {
          folderId,
          ownerId: auth.userId,
          size: obj.size,
          contentType: obj.contentType ?? null,
        },
      });
    return c.json({ data: { ...obj, folderId, ownerId: auth.userId } }, 201);
  })
  .get("/:key{.+}", requirePermission(filesCollection, "read"), async (c) => {
    const ctx = c.get("ctx");
    const perm = c.get("permission");
    const key = c.req.param("key");
    const t = filesTable(ctx.dialect);

    const conds: SQL[] = [eq(t.key, key)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .limit(1)) as FileRow[];
    if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");
    const obj = await ctx.storage.get(key);
    if (!obj) throw new AppError("NOT_FOUND", "Object not found");
    return new Response(obj.body, {
      headers: {
        "content-type":
          obj.meta.contentType ?? rows[0].contentType ?? "application/octet-stream",
        "content-length": String(obj.meta.size),
      },
    });
  })
  .delete("/:key{.+}", requirePermission(filesCollection, "delete"), async (c) => {
    const ctx = c.get("ctx");
    const perm = c.get("permission");
    const key = c.req.param("key");
    const t = filesTable(ctx.dialect);

    const conds: SQL[] = [eq(t.key, key)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select({ key: t.key })
      .from(t)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .limit(1)) as { key: string }[];
    if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");

    await ctx.storage.delete(key);
    await (ctx.db as any).delete(t).where(eq(t.key, key));
    return c.json({ ok: true });
  })
  /**
   * Toggle a file's ACL between public/private. Storage adapters that don't
   * track ACLs (fs/dev) ignore the bit; the row's `acl` column is the source
   * of truth for the API + UI either way.
   */
  .patch("/:key{.+}", requirePermission(filesCollection, "update"), async (c) => {
    const ctx = c.get("ctx");
    const perm = c.get("permission");
    const key = c.req.param("key");
    const body = (await c.req.json().catch(() => ({}))) as {
      acl?: "public" | "private";
      folderId?: string | null;
    };
    const t = filesTable(ctx.dialect);
    const conds: SQL[] = [eq(t.key, key)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select({ key: t.key })
      .from(t)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .limit(1)) as { key: string }[];
    if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");
    const patch: Record<string, unknown> = {};
    if (body.acl) patch.acl = body.acl;
    if (body.folderId !== undefined) patch.folderId = body.folderId;
    await (ctx.db as any).update(t).set(patch).where(eq(t.key, key));
    return c.json({ ok: true, data: { key, ...patch } });
  });
