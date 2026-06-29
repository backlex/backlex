import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { getRequestPermCache, requirePermission } from "../middleware/permission";
import { resolvePermission } from "../services/permissions";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

/** Comments are workspace-scoped — every query must pin the active tenant so a
 *  signed-in user from tenant A can never read or delete tenant B's threads.
 *  (The `comments` table carries `tenant_id`; older rows written before this
 *  fix may have it NULL and are simply invisible — they were never reliably
 *  attributable to a workspace anyway.) */
const requireTenant = (c: Context<AppBindings>): string => {
  const tenantId = c.get("auth")?.tenantId ?? null;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.comments : sqlite.schema.comments;

const CommentInput = z
  .object({
    collection: z.string().min(1),
    itemId: z.string().min(1),
    body: z.string().min(1).max(4000),
  })
  .openapi("CommentInput");

const CommentRow = z
  .object({
    id: z.string(),
    collection: z.string(),
    itemId: z.string(),
    userId: z.string().nullable(),
    body: z.string(),
    createdAt: z.unknown(),
  })
  .openapi("CommentRow");

const TAGS = ["comments"];

/**
 * Per-item discussion thread. Each comment is bound to (collection, itemId)
 * and stored separately from the dynamic `c_<slug>` table — admins can
 * reuse comments across migrations without ALTERing user collections.
 *
 * Access mirrors `revisions.ts`: every endpoint requires `read` permission on
 * the target collection and is scoped to the active workspace (`tenant_id`).
 * Creating/listing needs collection `read`; deleting is further restricted to
 * the comment's author or an admin.
 */
export const commentsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List comments on an item",
      description:
        "Requires `collection` + `itemId` query params and `read` permission on the collection.",
      security: SECURITY,
      middleware: [
        requireUser,
        requirePermission((c) => c.req.query("collection") ?? "", "read"),
      ],
      request: {
        query: z.object({
          collection: z.string(),
          itemId: z.string(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(CommentRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { collection, itemId } = c.req.valid("query");
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
        .where(
          and(
            eq(t.tenantId, tenantId),
            eq(t.collection, collection),
            eq(t.itemId, itemId),
          ),
        )
        .orderBy(desc(t.createdAt));
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Create a comment",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: CommentInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: CommentRow }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      // Commenting requires `read` on the target collection — the body carries
      // the slug so the gate runs here rather than as route middleware.
      const perm = await resolvePermission(
        ctx,
        auth,
        body.collection,
        "read",
        getRequestPermCache(c),
      );
      if (!perm.allowed) {
        throw new AppError(
          "FORBIDDEN",
          `No permission to read "${body.collection}"`,
        );
      }
      const t = tableFor(ctx.dialect);
      const id = crypto.randomUUID();
      const now = ctx.dialect === "pg" ? new Date() : Date.now();
      await (ctx.db as any).insert(t).values({
        id,
        tenantId,
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
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: TAGS,
      summary: "Delete a comment",
      description: "Only the author or an admin may delete.",
      security: SECURITY,
      middleware: [requireUser],
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
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      // Scope the lookup to the active workspace so a tenant-A admin can never
      // reach a tenant-B comment by guessing its id (admin role is tenant-scoped).
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new AppError("NOT_FOUND", "Comment not found");
      const isAdmin = auth.roles.includes("admin");
      if (!isAdmin && row.userId !== auth.userId) {
        throw new AppError("FORBIDDEN", "Only the author or admin can delete");
      }
      await (ctx.db as any)
        .delete(t)
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
      return c.json({ ok: true });
    },
  );
