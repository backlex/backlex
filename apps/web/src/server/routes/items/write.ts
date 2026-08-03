import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, type SQL } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import { ensureVersionedColumns } from "@backlex/db";
import type { AppBindings } from "../../app";
import { getRequestPermCache, requirePermission } from "../../middleware/permission";
import { resolvePermission } from "../../services/permissions";
import { deleteStagedRow, getStagedRow } from "../../services/items/staged";
import { publishEvent } from "../../services/events";
import { elapsedMs, recordActivity, requestMeta } from "../../services/activity";
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
import { refreshCollectionRollups } from "../../services/items/rollup";
import { defaultHook } from "../../lib/openapi-router";
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

export const itemsWriteRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
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
        "Partial update. `localized` fields merge into the existing per-locale value; pass `?locale=xx` with a native value to upsert one locale. On a staged-edits collection, a PATCH against a *published* row is stored as a staged patch (applied by the next publish) instead of changing the live row; `?live=1` (requires publish permission) bypasses staging and edits the live row directly.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ locale: z.string().optional(), live: z.enum(["1"]).optional() }),
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
      // `?live=1` opts out of staged-edits interception — since it changes
      // what's live on a published row, it needs the publish permission (the
      // same bar as the publish endpoint), not just update.
      const live = c.req.query("live") === "1";
      if (live && collection.versioned && collection.stagedEdits) {
        const pub = await resolvePermission(
          ctx,
          auth,
          collection.slug,
          "publish",
          getRequestPermCache(c),
        );
        if (!pub.allowed) {
          throw new AppError(
            "FORBIDDEN",
            "Editing the live row of a staged-edits collection requires the publish permission — omit ?live=1 to stage the change instead",
          );
        }
      }
      // Optional optimistic-concurrency precondition (see performUpdate).
      const ifUnmodifiedSince = c.req.header("x-if-unmodified-since");
      const res = await performUpdate(
        env,
        id,
        patch,
        { whereSql: perm.whereSql, fields: perm.fields },
        {
          ...(ifUnmodifiedSince !== undefined ? { ifUnmodifiedSince } : {}),
          ...(live ? { live: true } : {}),
        },
      );
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
      // Staged-edits apply: every real state transition folds the item's
      // pending staged patch into the row through the normal update path (so
      // validation, FTS/vector, revisions, and `updated` events all fire),
      // then clears it. Publishing applies BEFORE the status flip so the
      // publish stamp lands after the content write (no phantom "edited since
      // publish"); leaving published (unpublish/archive/schedule) applies
      // AFTER, once the row is a draft. Setting an expiry is not a state
      // change and leaves the patch alone.
      const applyStaged = async (): Promise<void> => {
        if (!collection.stagedEdits || event === "unpublish_scheduled") return;
        const staged = await getStagedRow(ctx, collection, id);
        if (!staged) return;
        if (Object.keys(staged.data).length > 0) {
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
          const res = await performUpdate(
            env,
            id,
            staged.data,
            { whereSql: perm.whereSql, fields: perm.fields },
            { live: true },
          );
          for (const fx of res.sideEffects) await fx();
        }
        await deleteStagedRow(ctx, collection, id);
      };
      if (event === "published") await applyStaged();
      await execute(
        ctx,
        sql`UPDATE ${sql.identifier(table)} SET ${setSql} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
      );
      if (event !== "published") await applyStaged();
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
      method: "delete",
      path: "/{slug}/{id}/staged",
      tags: TAGS,
      summary: "Discard an item's staged edits",
      description:
        "Deletes the pending staged patch of a staged-edits collection item without applying it — the live row is untouched. No-op (still 200) when nothing is staged.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
      },
      responses: {
        200: {
          description: "Discarded",
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
      // The caller must be able to update THIS row (tenant + row-level perm
      // filter), not just hold a scoped update permission on the collection.
      const tenantWhere = tenantFilter(collection, auth);
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT 1 AS one FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)} LIMIT 1`,
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
      await deleteStagedRow(ctx, collection, id);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "update",
          collection: collection.slug,
          itemId: id,
          ...requestMeta(c.req.raw),
          payload: { _stagedDiscarded: true },
          response: { ok: true },
          durationMs: elapsedMs(c),
        },
      );
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/rollups/refresh",
      tags: TAGS,
      summary: "Recompute a collection's rollup columns",
      description:
        "Restates every rollup field on this collection from the rows it aggregates, for every row in the workspace — one statement per rollup column. Ordinary writes keep these in step on their own; this is the repair path for the cases that bypass the per-write refresh: a restore or a template seed that wrote rows wholesale, a direct SQL edit, or a rollup added while another isolate still held a stale schema cache. Idempotent and safe to run at any time. Requires `update` on the collection.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string() }),
      },
      responses: {
        200: {
          description: "Refreshed",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), refreshed: z.array(z.string()) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const refreshed = await refreshCollectionRollups(ctx, auth.tenantId, collection);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId,
          action: "update",
          collection: collection.slug,
          itemId: "__rollups__",
          ...requestMeta(c.req.raw),
          payload: { refreshed },
          response: { ok: true },
          durationMs: elapsedMs(c),
        },
      );
      return c.json({ ok: true, refreshed });
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
