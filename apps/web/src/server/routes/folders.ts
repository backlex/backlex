import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { FILES_COLLECTION } from "./storage";
import { defaultHook } from "../lib/openapi-router";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.folders : sqlite.schema.folders;

const filesTableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.files : sqlite.schema.files;

const FolderInput = z
  .object({
    name: z.string().min(1),
    parentId: z.string().nullable().optional(),
  })
  .openapi("FolderInput");

const FolderRow = z
  .object({
    id: z.string(),
    name: z.string(),
    parentId: z.string().nullable(),
    ownerId: z.string().nullable(),
    tenantId: z.string().nullable(),
  })
  .openapi("FolderRow");

const filesPerm = () => FILES_COLLECTION;

const requireTenantId = (auth: { tenantId?: string | null }): string => {
  if (!auth.tenantId) {
    throw new AppError("VALIDATION", "Active tenant is required for folder operations");
  }
  return auth.tenantId;
};

const tags = ["folders"];

export const foldersRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List folders",
      description:
        "Returns every folder in the active workspace, scoped by `read` permission on the files collection.",
      security: SECURITY,
      middleware: [requirePermission(filesPerm, "read")],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(FolderRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
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
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create folder",
      security: SECURITY,
      middleware: [requirePermission(filesPerm, "create")],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: FolderInput } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": { schema: z.object({ data: FolderRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenantId(auth);
      const body = c.req.valid("json");
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
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update folder",
      security: SECURITY,
      middleware: [requirePermission(filesPerm, "update")],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: FolderInput.partial() } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const tenantId = requireTenantId(auth);
      const body = c.req.valid("json");
      const { id } = c.req.valid("param");
      const t = tableFor(ctx.dialect);
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
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete folder",
      security: SECURITY,
      middleware: [requirePermission(filesPerm, "delete")],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const tenantId = requireTenantId(auth);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      const conds: SQL[] = [eq(t.id, id), eq(t.tenantId, tenantId)];
      if (perm.whereSql) conds.push(perm.whereSql);
      const existing = await (ctx.db as any)
        .select({ id: t.id, parentId: t.parentId })
        .from(t)
        .where(and(...conds))
        .limit(1);
      if (!existing[0]) throw new AppError("NOT_FOUND", "Folder not found");

      // Detach what points at this folder BEFORE removing it, in both
      // dialects, rather than leaving it to the database.
      //
      // The two dialects do not agree on their own. Postgres carries
      // `ON DELETE SET NULL` on `files.folder_id`; the hand-written SQLite
      // migration wrote a plain `REFERENCES folders(id)`, so the Drizzle
      // schema's `onDelete: "set null"` never reached the DDL there — and
      // deleting a folder holding any file raised a FOREIGN KEY error, which
      // surfaced as a 500 on every SQLite and D1 deployment, i.e. the default
      // one. `folders.parent_id` has no constraint at all, so a subtree was
      // silently orphaned instead.
      //
      // Doing it here makes the two behave identically and makes the promise
      // explicit: a folder is a label, so removing it unfiles its contents and
      // promotes its children. Nothing is destroyed — deleting files is
      // `DELETE /api/storage/:key`, deliberately a separate decision.
      const parentId = existing[0].parentId ?? null;
      const files = filesTableFor(ctx.dialect);
      await (ctx.db as any)
        .update(files)
        .set({ folderId: null })
        .where(and(eq(files.folderId, id), eq(files.tenantId, tenantId)));
      await (ctx.db as any)
        .update(t)
        .set({ parentId })
        .where(and(eq(t.parentId, id), eq(t.tenantId, tenantId)));

      await (ctx.db as any)
        .delete(t)
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
      return c.json({ ok: true });
    },
  );
