import { Hono } from "hono";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { logActivity } from "../services/activity";

export const FILES_COLLECTION = "system_files";

/**
 * Reserved physical-key prefix that namespaces every uploaded object under
 * `tenants/<tenant-id>/`. Stored on disk + in `files.key`; never exposed to
 * API clients (we strip it on read and re-add it on write). Two tenants can
 * therefore reuse the same logical key (e.g. "logo.png") without colliding
 * either in the bucket or in the DB primary key.
 */
const TENANT_PREFIX = "tenants/";

const physicalKey = (tenantId: string, logical: string): string =>
  `${TENANT_PREFIX}${tenantId}/${logical}`;

const stripTenantPrefix = (tenantId: string, physical: string): string => {
  const prefix = `${TENANT_PREFIX}${tenantId}/`;
  return physical.startsWith(prefix) ? physical.slice(prefix.length) : physical;
};

const requireTenantId = (auth: { tenantId?: string | null }): string => {
  if (!auth.tenantId) {
    throw new AppError("VALIDATION", "Active tenant is required for storage operations");
  }
  return auth.tenantId;
};

const guardLogicalKey = (key: string) => {
  if (key.startsWith(TENANT_PREFIX)) {
    throw new AppError("VALIDATION", `Key prefix "${TENANT_PREFIX}" is reserved`);
  }
};

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
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const t = filesTable(ctx.dialect);
    const prefix = c.req.query("prefix") ?? "";
    const physicalPrefix = physicalKey(tenantId, prefix);

    const conds: SQL[] = [
      eq(t.tenantId, tenantId),
      sql`${sql.identifier("key")} LIKE ${`${physicalPrefix}%`}`,
    ];
    if (perm.whereSql) conds.push(perm.whereSql);

    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(...conds))) as FileRow[];

    return c.json({
      data: rows.map((r) => ({
        key: stripTenantPrefix(tenantId, r.key),
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
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const key = physicalKey(tenantId, logicalKey);
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
        tenantId,
        size: obj.size,
        contentType: obj.contentType ?? null,
      })
      .onConflictDoUpdate({
        target: t.key,
        set: {
          folderId,
          ownerId: auth.userId,
          tenantId,
          size: obj.size,
          contentType: obj.contentType ?? null,
        },
      });
    await logActivity(c, {
      action: "upload",
      collection: FILES_COLLECTION,
      itemId: logicalKey,
      payload: { size: obj.size, contentType: obj.contentType, folderId },
    });
    return c.json(
      {
        data: {
          ...obj,
          key: logicalKey,
          folderId,
          ownerId: auth.userId,
        },
      },
      201,
    );
  })
  .get("/:key{.+}", requirePermission(filesCollection, "read"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const key = physicalKey(tenantId, logicalKey);
    const t = filesTable(ctx.dialect);

    const conds: SQL[] = [eq(t.key, key), eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(...conds))
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
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const key = physicalKey(tenantId, logicalKey);
    const t = filesTable(ctx.dialect);

    const conds: SQL[] = [eq(t.key, key), eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select({ key: t.key })
      .from(t)
      .where(and(...conds))
      .limit(1)) as { key: string }[];
    if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");

    await ctx.storage.delete(key);
    await (ctx.db as any)
      .delete(t)
      .where(and(eq(t.key, key), eq(t.tenantId, tenantId)));
    await logActivity(c, {
      action: "delete",
      collection: FILES_COLLECTION,
      itemId: logicalKey,
    });
    return c.json({ ok: true });
  })
  /**
   * Toggle a file's ACL between public/private. Storage adapters that don't
   * track ACLs (fs/dev) ignore the bit; the row's `acl` column is the source
   * of truth for the API + UI either way.
   */
  .patch("/:key{.+}", requirePermission(filesCollection, "update"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const key = physicalKey(tenantId, logicalKey);
    const body = (await c.req.json().catch(() => ({}))) as {
      acl?: "public" | "private";
      folderId?: string | null;
    };
    const t = filesTable(ctx.dialect);
    const conds: SQL[] = [eq(t.key, key), eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select({ key: t.key })
      .from(t)
      .where(and(...conds))
      .limit(1)) as { key: string }[];
    if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");
    const patch: Record<string, unknown> = {};
    if (body.acl) patch.acl = body.acl;
    if (body.folderId !== undefined) patch.folderId = body.folderId;
    await (ctx.db as any)
      .update(t)
      .set(patch)
      .where(and(eq(t.key, key), eq(t.tenantId, tenantId)));
    await logActivity(c, {
      action: "update",
      collection: FILES_COLLECTION,
      itemId: logicalKey,
      payload: patch,
    });
    return c.json({ ok: true, data: { key: logicalKey, ...patch } });
  });
