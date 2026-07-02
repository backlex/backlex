import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, type SQL } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { publishEvent } from "../../services/events";
import { elapsedMs, requestMeta } from "../../services/activity";
import { SECURITY, OkSchema, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  loadCollection,
} from "../../services/items/collection-loader";
import {
  deserializeRow,
} from "../../services/items/serialize";
import {
  performCreate,
  performUpdate,
  performDelete,
  type WriteEnv,
} from "../../services/items/write";
import {
  execute,
  fromOf,
  nowFor,
  pkEq,
  queryAll,
  selectStar,
  tenantFilter,
  whereOf,
} from "../../services/items/sql-helpers";
import {
  ItemBody,
  ItemRow,
  TAGS,
} from "../../services/items/schemas";

export const itemsWriteRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}",
      tags: TAGS,
      summary: "Create item",
      description:
        "Creates a row in the collection. Body shape is the collection's field map; adopted collections must include the primary key value.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "create")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ locale: z.string().optional() }),
        body: {
          required: true,
          content: { "application/json": { schema: ItemBody } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const data = (await c.req.json()) as Record<string, unknown>;
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
      };
      const res = await performCreate(env, data, {
        whereSql: perm.whereSql,
        fields: perm.fields,
      });
      for (const fx of res.sideEffects) await fx();
      return c.json({ data: res.data ?? {} }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Update item",
      description:
        "Partial update. `i18n_text` fields merge into the existing locale map; pass `?locale=xx` with a string value to upsert one locale.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ locale: z.string().optional() }),
        body: {
          required: true,
          content: { "application/json": { schema: ItemBody } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const id = c.req.param("id");
      const patch = (await c.req.json()) as Record<string, unknown>;
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
      };
      const res = await performUpdate(env, id, patch, {
        whereSql: perm.whereSql,
        fields: perm.fields,
      });
      for (const fx of res.sideEffects) await fx();
      return c.json({ data: res.data ?? {} });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Delete item",
      description: "Hard-deletes the row. Cascades to ownership side table + vector store.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "delete")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
      },
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
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const id = c.req.param("id");
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: null,
      };
      const res = await performDelete(env, id, {
        whereSql: perm.whereSql,
        fields: perm.fields,
      });
      for (const fx of res.sideEffects) await fx();
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/{id}/publish",
      tags: TAGS,
      summary: "Publish, unpublish, or schedule a versioned item",
      description:
        "Versioned-collection only. Publishes now by default; `?unpublish=1` reverts to draft; body `{ publishAt }` (future ISO) schedules a publish that the cron tick applies when due, `{ publishAt: null }` cancels it.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "publish")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ unpublish: z.enum(["1"]).optional() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({ publishAt: z.string().datetime().nullable().optional() }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      if (!collection.versioned) {
        throw new AppError(
          "VALIDATION",
          "Collection is not versioned — set `versioned: true` on the collection first",
        );
      }
      const id = c.req.param("id");
      const table = collection.physicalTable;
      const tenantWhere = tenantFilter(collection, auth);
      const unpublish = c.req.query("unpublish") === "1";
      const body = (await c.req.json().catch(() => ({}))) as { publishAt?: string | null };
      const now = nowFor(ctx.dialect);
      const tsOf = (d: Date): Date | number => (ctx.dialect === "pg" ? d : d.getTime());

      // Decide the operation: unpublish > schedule (future publishAt) > publish-now.
      const scheduleAt =
        body.publishAt && new Date(body.publishAt).getTime() > Date.now()
          ? new Date(body.publishAt)
          : null;
      let event: "published" | "unpublished" | "scheduled";
      let setSql: SQL;
      if (unpublish) {
        event = "unpublished";
        setSql = sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("_publish_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`;
      } else if (scheduleAt) {
        event = "scheduled";
        setSql = sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("_publish_at")} = ${tsOf(scheduleAt)}, ${sql.identifier("updated_at")} = ${now}`;
      } else {
        event = "published";
        setSql = sql`${sql.identifier("_status")} = 'published', ${sql.identifier("_published_at")} = ${now}, ${sql.identifier("_publish_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`;
      }
      await execute(
        ctx,
        sql`UPDATE ${sql.identifier(table)} SET ${setSql} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
      );
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)} LIMIT 1`,
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
      const after = deserializeRow(rows[0], collection.fields, ctx.dialect, collection.ownerScoped);
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event, data: after },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      return c.json({ data: after });
    },
  );
