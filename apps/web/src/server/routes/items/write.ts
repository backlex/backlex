import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, type SQL } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import { ensureVersionedColumns } from "@backlex/db";
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
import { verifyHashField } from "../../services/items/verify";
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
        email: auth.email,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
      };
      const res = await performCreate(env, data, {
        whereSql: perm.whereSql,
        fields: perm.fields,
      });
      for (const fx of res.sideEffects) await fx();
      return c.json({ data: res.data ?? {}, ...(res.warnings ? { warnings: res.warnings } : {}) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Update item",
      description:
        "Partial update. `localized` fields merge into the existing per-locale value; pass `?locale=xx` with a native value to upsert one locale.",
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
        email: auth.email,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
      };
      const res = await performUpdate(env, id, patch, {
        whereSql: perm.whereSql,
        fields: perm.fields,
      });
      for (const fx of res.sideEffects) await fx();
      return c.json({ data: res.data ?? {}, ...(res.warnings ? { warnings: res.warnings } : {}) });
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
        email: auth.email,
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
      summary: "Publish, unpublish, archive, or (un)schedule a versioned item",
      description:
        "Versioned-collection only. Publishes now by default; `?unpublish=1` reverts to draft; `?archive=1` archives (hidden from readers, like a draft, but a distinct 'pulled from publication' state); body `{ publishAt }` (future ISO) schedules a publish the cron tick applies when due, `{ publishAt: null }` cancels it; body `{ unpublishAt }` (future ISO) sets an expiry the cron reverts to draft when due (preserving the current state), `{ unpublishAt: null }` cancels it. Archived rows leave archived via a normal publish/unpublish.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "publish")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ unpublish: z.enum(["1"]).optional(), archive: z.enum(["1"]).optional() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                publishAt: z.string().datetime().nullable().optional(),
                unpublishAt: z.string().datetime().nullable().optional(),
              }),
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
      // Heal tables that predate scheduled publishing before we touch them:
      // publish/unpublish/schedule all write `_publish_at`, and a versioned
      // table created before that column existed (schema never re-applied) would
      // otherwise 500 with "no such column: _publish_at". Idempotent + cheap.
      await ensureVersionedColumns(ctx.db, ctx.dialect, table);
      const tenantWhere = tenantFilter(collection, auth);
      const unpublish = c.req.query("unpublish") === "1";
      const archive = c.req.query("archive") === "1";
      const body = (await c.req.json().catch(() => ({}))) as {
        publishAt?: string | null;
        unpublishAt?: string | null;
      };
      const now = nowFor(ctx.dialect);
      const tsOf = (d: Date): Date | number => (ctx.dialect === "pg" ? d : d.getTime());

      // Decide the operation: unpublish > archive > schedule (future publishAt) >
      // set-expiry (`unpublishAt`, no state change) > publish-now. Every state
      // change clears `_unpublish_at` so a fresh publish/draft carries no stale
      // expiry. Archiving clears the timestamps (like unpublish) but lands in the
      // distinct `archived` state; it leaves archived via publish/unpublish.
      const scheduleAt =
        body.publishAt && new Date(body.publishAt).getTime() > Date.now()
          ? new Date(body.publishAt)
          : null;
      const hasUnpublishAt = Object.hasOwn(body, "unpublishAt");
      const expireAt =
        body.unpublishAt && new Date(body.unpublishAt).getTime() > Date.now()
          ? new Date(body.unpublishAt)
          : null;
      let event: "published" | "unpublished" | "archived" | "scheduled" | "unpublish_scheduled";
      let setSql: SQL;
      if (unpublish) {
        event = "unpublished";
        setSql = sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("_publish_at")} = NULL, ${sql.identifier("_unpublish_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`;
      } else if (archive) {
        event = "archived";
        setSql = sql`${sql.identifier("_status")} = 'archived', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("_publish_at")} = NULL, ${sql.identifier("_unpublish_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`;
      } else if (scheduleAt) {
        event = "scheduled";
        setSql = sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("_publish_at")} = ${tsOf(scheduleAt)}, ${sql.identifier("_unpublish_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`;
      } else if (hasUnpublishAt && body.publishAt == null) {
        // Set/clear the expiry (auto-unpublish) time. Preserves `_status` and does
        // NOT bump `updated_at` — scheduling an expiry isn't a content edit, so it
        // must not trip the "edited since publish" indicator.
        event = "unpublish_scheduled";
        setSql = sql`${sql.identifier("_unpublish_at")} = ${expireAt ? tsOf(expireAt) : sql`NULL`}`;
      } else {
        event = "published";
        setSql = sql`${sql.identifier("_status")} = 'published', ${sql.identifier("_published_at")} = ${now}, ${sql.identifier("_publish_at")} = NULL, ${sql.identifier("_unpublish_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`;
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
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/{id}/verify",
      tags: TAGS,
      summary: "Verify a hashed-field value",
      description:
        "Checks a plaintext against the stored digest of a `hash` field on the row without ever returning the digest. Body: `{ field, value }`. Requires read permission on the item; throttled per (collection, item, field) to blunt brute-force; every attempt is audit-logged.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ field: z.string().min(1), value: z.string().min(1) }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Verification result",
          content: {
            "application/json": { schema: z.object({ valid: z.boolean() }) },
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
      const { field, value } = (await c.req.json()) as { field?: string; value?: string };
      if (!field) throw new AppError("VALIDATION", "`field` is required");
      const valid = await verifyHashField(
        ctx,
        collection,
        { userId: auth.userId, tenantId: auth.tenantId, roles: auth.roles },
        { whereSql: perm.whereSql, fields: perm.fields },
        id,
        field,
        value,
        requestMeta(c.req.raw),
      );
      return c.json({ valid });
    },
  );
