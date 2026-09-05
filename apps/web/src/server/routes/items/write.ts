import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, type SQL } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import { ensureVersionedColumns } from "@backlex/db";
import type { AppBindings } from "../../app";
import { getRequestPermCache, requirePermission } from "../../middleware/permission";
import { resolvePermission } from "../../services/permissions";
import { deleteStagedRow, getStagedRow } from "../../services/items/staged";
import { publishEvent } from "../../services/events";
import { elapsedMs, keepAlive, recordActivity, requestMeta } from "../../services/activity";
import { startLongJob } from "../../services/jobs-long-running";
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
import {
  assertCanRearrange,
  normalizeOrderField,
  orderFieldsOf,
  reorderItem,
  requireOrderField,
} from "../../services/items/order";
import {
  peekSequenceValues,
  sequenceFieldsOf,
  syncSequenceCounters,
} from "../../services/items/sequence";
import { backfillSlugs, slugFieldsOf } from "../../services/items/slug";
import { setRetired } from "../../services/items/retirement";
import { defaultHook } from "../../lib/openapi-router";

/**
 * The fields this caller may READ back — what a write's response is projected
 * through. Not the write grant's list: see `WriteEnv.readFields`.
 *
 * A caller with no read grant at all gets an empty set rather than `null`,
 * because `null` means "unrestricted" downstream and a missing grant is the
 * opposite of that.
 */
const readFieldsFor = async (
  c: Parameters<typeof getRequestPermCache>[0],
  slug: string,
): Promise<Set<string> | null> => {
  const readPerm = await resolvePermission(
    c.get("ctx"),
    c.get("auth"),
    slug,
    "read",
    getRequestPermCache(c),
  );
  return readPerm.allowed ? readPerm.fields : new Set<string>();
};
import {
  deletedFilter,
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
import { readJson, readJsonOr } from "../../lib/body";

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
      const data = (await readJson(c.req)) as Record<string, unknown>;
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        email: auth.email,
        orgId: auth.orgId ?? null,
        orgRole: auth.orgRole ?? null,
        orgIds: auth.orgIds ?? [],
        meta: requestMeta(c.req.raw),
        impersonatedBy: auth.impersonatedBy ?? null,
        impersonationReadOnly: auth.impersonationReadOnly ?? false,
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
        readFields: await readFieldsFor(c, collection.slug),
      };
      const res = await performCreate(env, data, {
        whereSql: perm.whereSql,
        fields: perm.fields,
        conditions: perm.conditions,
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
      const patch = (await readJson(c.req)) as Record<string, unknown>;
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        email: auth.email,
        orgId: auth.orgId ?? null,
        orgRole: auth.orgRole ?? null,
        orgIds: auth.orgIds ?? [],
        meta: requestMeta(c.req.raw),
        impersonatedBy: auth.impersonatedBy ?? null,
        impersonationReadOnly: auth.impersonationReadOnly ?? false,
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
        readFields: await readFieldsFor(c, collection.slug),
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
        { whereSql: perm.whereSql, fields: perm.fields, conditions: perm.conditions },
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
        orgId: auth.orgId ?? null,
        orgRole: auth.orgRole ?? null,
        orgIds: auth.orgIds ?? [],
        meta: requestMeta(c.req.raw),
        impersonatedBy: auth.impersonatedBy ?? null,
        impersonationReadOnly: auth.impersonationReadOnly ?? false,
        durationMs: () => elapsedMs(c),
        locale: null,
        readFields: await readFieldsFor(c, collection.slug),
      };
      const res = await performDelete(env, id, {
        whereSql: perm.whereSql,
        fields: perm.fields,
        conditions: perm.conditions,
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
      const body = (await readJsonOr(c.req, {})) as {
        publishAt?: string | null;
        unpublishAt?: string | null;
      };
      const now = nowFor(ctx.dialect);
      const tsOf = (d: Date): Date | number => (ctx.dialect === "pg" ? d : d.getTime());

      // Decide the operation: unpublish > archive > schedule (future publishAt) >
      // set-expiry (`unpublishAt`, no state change) > publish-now. A state change
      // clears `_unpublish_at` so a fresh publish/draft carries no stale expiry —
      // except a scheduled publish carrying its OWN `unpublishAt`, which is the
      // caller setting a window rather than a leftover. Archiving clears the
      // timestamps (like unpublish) but lands in the distinct `archived` state;
      // it leaves archived via publish/unpublish.
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
        // A window, not just a start. `_unpublish_at` is cleared on every state
        // change so a fresh publish cannot inherit a STALE expiry — but an
        // `unpublishAt` sent in THIS body is not stale, it is the other half of
        // the instruction. It used to be dropped here, silently and under a 200:
        // "publish at 09:00, pull it at 17:00" scheduled the publish and left the
        // row with no expiry at all, which is the one combination a scheduling
        // feature exists for. Absent (or past, or explicitly null) still clears.
        setSql = sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("_publish_at")} = ${tsOf(scheduleAt)}, ${sql.identifier("_unpublish_at")} = ${expireAt ? tsOf(expireAt) : sql`NULL`}, ${sql.identifier("updated_at")} = ${now}`;
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
            orgId: auth.orgId ?? null,
            orgRole: auth.orgRole ?? null,
            orgIds: auth.orgIds ?? [],
            meta: requestMeta(c.req.raw),
        impersonatedBy: auth.impersonatedBy ?? null,
        impersonationReadOnly: auth.impersonationReadOnly ?? false,
            durationMs: () => elapsedMs(c),
            locale: null,
            readFields: await readFieldsFor(c, collection.slug),
          };
          const res = await performUpdate(
            env,
            id,
            staged.data,
            { whereSql: perm.whereSql, fields: perm.fields, conditions: perm.conditions },
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
        { tenantId: auth.tenantId ?? null, channel: `items:${collection.slug}` },
        { event, data: after },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx },
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
        query: z.object({
          async: z.enum(["0", "1"]).optional().openapi({
            description:
              "`1` runs the refresh as a durable background job and answers 202 with a `jobId`; watch it on `GET /api/jobs/{id}`. The job re-resolves `update` on this collection when it runs, so a grant revoked in the meantime stops it. Not available to API keys, workspace end-users or impersonation sessions.",
          }),
        }),
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
        202: {
          description: "Queued",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), jobId: z.string(), status: z.string() }),
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
      if (c.req.query("async") === "1") {
        const { jobId } = await startLongJob(ctx, {
          type: "collection.reindex",
          auth,
          payload: { slug: c.req.param("slug"), kinds: ["rollups"] },
          background: (p) => keepAlive(c, p),
        });
        return c.json({ ok: true, jobId, status: "queued" as const }, 202);
      }
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
      // Explicit `200`: with a 202 also declared, a bare `c.json(x)` widens the
      // inferred status to the union and the compiler asks this body to satisfy
      // the queued shape too.
      return c.json({ ok: true, refreshed }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/{id}/retire",
      tags: TAGS,
      summary: "Take a row out of play, or put it back",
      description:
        "Sets the collection's retirement flag on one row — the boolean declared with `retire`, spelled `active` in most schemas. `?restore=1` puts the row back in play. Retirement never hides the row from a read: every existing reference still resolves and the row is still returned by list and get. What changes is that it stops being OFFERED for new work — the relation pickers skip it, `?retired=exclude` filters it out, and (unless the flag declares `references: \"allow\"`) a write pointing a NEW relation at it is refused with 422. Requires `update` on the collection, and specifically an update that covers the flag column: a role refused a PATCH of `active` is refused this too. Unlike `reorder`, a row-conditioned grant is honoured rather than refused — retiring one row does not touch any other, so retiring what the caller can see is a complete answer.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ restore: z.enum(["1"]).optional() }),
      },
      responses: {
        200: {
          description: "Retired (or restored)",
          content: {
            "application/json": {
              schema: z.object({
                data: ItemRow,
                /** The flag column that was written. */
                field: z.string(),
                /** Where the row ended up. */
                retired: z.boolean(),
              }),
            },
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
      const retired = c.req.query("restore") !== "1";
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        email: auth.email,
        orgId: auth.orgId ?? null,
        orgRole: auth.orgRole ?? null,
        orgIds: auth.orgIds ?? [],
        meta: requestMeta(c.req.raw),
        impersonatedBy: auth.impersonatedBy ?? null,
        impersonationReadOnly: auth.impersonationReadOnly ?? false,
        durationMs: () => elapsedMs(c),
        locale: null,
        readFields: await readFieldsFor(c, collection.slug),
      };
      const res = await setRetired(env, id, retired, {
        whereSql: perm.whereSql,
        fields: perm.fields,
        conditions: perm.conditions,
      });
      return c.json(res);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/reorder",
      tags: TAGS,
      summary: "Move a row to a new place in its hand-arranged list",
      description:
        "Moves one row so it sits immediately `before` or `after` another in the same list, renumbering only the rows between the two. Exactly one of `before` / `after` is required, and both rows must be in the same list — moving a row between lists is a change to the scope column and belongs in a PATCH. If the list still holds duplicate positions (every collection whose `position` column defaulted to 0 does), it is renumbered into the order it currently reads BEFORE the move, and the count is reported as `repaired`. Requires `update` on the collection — and specifically an UNCONDITIONED one that includes this field: a move renumbers rows the caller never named, so a role whose `update` is limited to some rows, or to a field list that excludes this column, is refused (403) rather than allowed to rewrite other people's ordering or to renumber a subset that then collides with the rows it skipped.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                /** The order field being rearranged. Named rather than inferred:
                 *  a collection may carry more than one arrangement. */
                field: z.string().min(1),
                /** The row to move. */
                id: z.string().min(1),
                /** Put it immediately before this row. */
                before: z.string().min(1).optional(),
                /** Put it immediately after this row. */
                after: z.string().min(1).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Moved",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  /** Where the row ended up. */
                  position: z.number().int(),
                  /** Rows that stepped aside to make room. */
                  shifted: z.number().int(),
                  /** Rows renumbered by the tie repair that ran first. */
                  repaired: z.number().int(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { field, id, before, after } = c.req.valid("json");
      // Exactly one anchor. Accepting both would mean picking one silently, and
      // accepting neither would mean inventing a destination.
      if ((before === undefined) === (after === undefined)) {
        throw new AppError("VALIDATION", 'Send exactly one of "before" or "after"');
      }
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const orderField = requireOrderField(collection, field);
      // A move renumbers rows the caller never named, so plain `update` on the
      // collection is not enough — see `assertCanRearrange`.
      assertCanRearrange(collection, orderField, c.get("permission"));
      const data = await reorderItem(
        ctx,
        collection,
        auth.tenantId,
        orderField,
        {
          id,
          anchorId: (before ?? after)!,
          place: before !== undefined ? "before" : "after",
        },
        c.get("permission").whereSql,
      );
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "update",
          collection: collection.slug,
          itemId: id,
          ...requestMeta(c.req.raw),
          payload: { field, before, after },
          response: { data },
          durationMs: elapsedMs(c),
        },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/order/normalize",
      tags: TAGS,
      summary: "Renumber a hand-arranged list into 1…N",
      description:
        "Rewrites an order field's positions to 1, 2, 3 … within each list, preserving the order the rows currently read in (position, then primary key). The repair path for a column that predates the field being declared one: every schema template's `position` defaults to 0, so all its rows are tied and the sort over them is whatever the planner returned. Unlike the email and phone normalizers this cannot be paged within a list — breaking a tie means rewriting the whole list — so a single list larger than 10,000 rows is refused rather than silently rewritten. Idempotent. Requires an UNCONDITIONED `update` on the collection that covers the order column — this rewrites every list in it, so a role limited to some rows or some fields is refused (403).",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string() }),
        body: {
          // Every member is optional, so a bodyless POST is a legitimate call
          // ("normalize everything"). Marking it required would 400 the simplest
          // form of the request — and a bodyless POST does not even send a
          // content-type for the validator to match on.
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                /** Which order field to renumber. Omit to do all of them. */
                field: z.string().min(1).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Normalized",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  /** Distinct lists examined across every field touched. */
                  scopes: z.number().int(),
                  /** Rows whose position changed. */
                  renumbered: z.number().int(),
                  fields: z.array(z.string()),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      // Read leniently rather than through `c.req.valid`: with every member
      // optional a bodyless POST is a legitimate call, and one of those carries
      // no content-type for the validator to match on. Same shape as the
      // publish route above. `field` is only ever matched against this
      // collection's own field list before it reaches any statement.
      const body = (await readJsonOr(c.req, {})) as { field?: unknown };
      const field = typeof body.field === "string" && body.field ? body.field : undefined;
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const targets = field
        ? [requireOrderField(collection, field)]
        : orderFieldsOf(collection.fields);
      // Same gate as `reorder`, and it matters more here: normalize rewrites
      // EVERY list in the collection. Checked per field so a caller whose
      // allow-list covers one order column but not another is told which.
      for (const f of targets) assertCanRearrange(collection, f, c.get("permission"));
      let scopes = 0;
      let renumbered = 0;
      for (const f of targets) {
        const r = await normalizeOrderField(ctx, collection, auth.tenantId, f);
        scopes += r.scopes;
        renumbered += r.renumbered;
      }
      const data = { scopes, renumbered, fields: targets.map((f) => f.name) };
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "update",
          collection: collection.slug,
          itemId: "__order__",
          ...requestMeta(c.req.raw),
          payload: { field: field ?? null },
          response: { data },
          durationMs: elapsedMs(c),
        },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/slugs/backfill",
      tags: TAGS,
      summary: "Fill in slugs for rows that have none",
      description:
        "Folds a URL slug out of each row's source column for every row whose slug field is empty, and takes the next free suffix when the obvious answer is taken. The repair path for a column that predates the field being declared one: every slug in the schema-template catalog is optional and nothing server-side ever generated one, so a workspace can hold years of rows with no handle at all. Rows that ALREADY have a slug are never touched — that slug may be a published URL. Text with no Latin letters to fold is reported as `unfoldable` rather than given an invented token. Runs as a DRY RUN unless `apply` is true, so the result can be read before anything is written. Idempotent. Requires `update` on the collection covering the slug column; the caller's row condition is applied rather than refused, since each row's slug is independent of the rest.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string() }),
        body: {
          // Every member optional ⇒ a bodyless POST is a legitimate call (dry
          // run, every field). Marking it required would 400 the simplest form
          // of the request, which does not even send a content-type.
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                /** Which slug field to fill. Omit to do all of them. */
                field: z.string().min(1).optional(),
                /** Write the values. Omitted or false ⇒ report only. */
                apply: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Backfilled",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  dryRun: z.boolean(),
                  fields: z.array(
                    z.object({
                      field: z.string(),
                      examined: z.number().int(),
                      filled: z.number().int(),
                      unfoldable: z.number().int(),
                      entries: z.array(z.object({ id: z.string(), slug: z.string() })),
                    }),
                  ),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      // Read leniently — a bodyless POST is the dry run, and it carries no
      // content-type for the validator to match on. Same shape as
      // `order/normalize` above. `field` is matched against this collection's
      // own field list before it reaches any statement.
      const body = (await readJsonOr(c.req, {})) as {
        field?: unknown;
        apply?: unknown;
      };
      const wanted = typeof body.field === "string" && body.field ? body.field : undefined;
      const dryRun = body.apply !== true;
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const all = slugFieldsOf(collection.fields);
      let targets = all;
      if (wanted) {
        const hit = all.find((f) => f.name === wanted);
        if (!hit) {
          throw new AppError("VALIDATION", `"${wanted}" is not a slug field on this collection`);
        }
        targets = [hit];
      }
      // The field allow-list is a refusal, exactly as it is for `reorder`: a
      // role granted `update` with `fields: ["title"]` is correctly refused a
      // PATCH of the slug column, and must not be able to write it through a
      // maintenance route instead. Checked per field so a caller whose
      // allow-list covers one slug column but not another is told which.
      for (const f of targets) {
        if (perm.fields && !perm.fields.has(f.name)) {
          throw new AppError("FORBIDDEN", `No permission to write field "${f.name}"`);
        }
      }
      // The FULL row scope — permission condition, tenant, soft-delete —
      // restated for the service to put on both its SELECT and its UPDATEs.
      // Holding `update` on a collection is not holding it on every row.
      const scope = sql`${sql.join(
        [
          perm.whereSql,
          tenantFilter(collection, auth),
          deletedFilter(collection),
          sql`1=1`,
        ].filter((f): f is SQL => f != null),
        sql` AND `,
      )}`;
      const fields = [];
      for (const f of targets) {
        fields.push(await backfillSlugs(ctx, collection, f, { scope, dryRun, db: undefined }));
      }
      const data = { dryRun, fields };
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "update",
          collection: collection.slug,
          itemId: "__slugs__",
          ...requestMeta(c.req.raw),
          payload: { field: wanted ?? null, apply: !dryRun },
          response: { data },
          durationMs: elapsedMs(c),
        },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/sequences/sync",
      tags: TAGS,
      summary: "Catch a collection's sequence counters up to its rows",
      description:
        "Reads every value already stored in this collection's sequence columns and moves each counter forward to the highest number it finds, per reset period. The repair path for a series that predates its counter: a table adopted with numbers already in it, a restore from a dump taken before the counter existed, or rows seeded around the write path. Counters are only ever moved FORWARD — lowering one would reissue numbers that are already on documents. Values that this field's pattern could not have produced are reported as `unreadable` rather than guessed at. Idempotent. Requires `update` on the collection.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string() }),
      },
      responses: {
        200: {
          description: "Synced",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                synced: z.array(
                  z.object({
                    field: z.string(),
                    advanced: z.array(z.object({ scope: z.string(), to: z.number() })),
                    unreadable: z.number(),
                  }),
                ),
              }),
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
      const synced = await syncSequenceCounters(
        ctx,
        auth.tenantId,
        collection,
        sequenceFieldsOf(collection.fields),
      );
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId,
          action: "update",
          collection: collection.slug,
          itemId: "__sequences__",
          ...requestMeta(c.req.raw),
          payload: { synced },
          response: { ok: true },
          durationMs: elapsedMs(c),
        },
      );
      return c.json({ ok: true, synced });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/sequences/next",
      tags: TAGS,
      summary: "Peek at the next number each sequence field would issue",
      // Three segments, not `/{slug}/sequences` — that shape is indistinguishable
      // from `GET /{slug}/{id}` with an id of "sequences", and the item route
      // wins, answering 404.
      description:
        "Returns the value each sequence column on this collection would render next, without consuming it. A preview by nature — another create can take that number before this one is acted on — so it is for showing an operator what to expect, never for writing. Requires `read` on the collection.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
      },
      responses: {
        200: {
          description: "Next values, keyed by field name",
          content: {
            "application/json": {
              schema: z.object({ data: z.record(z.string(), z.string()) }),
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
      const data = await peekSequenceValues(
        ctx,
        auth.tenantId,
        collection.slug,
        sequenceFieldsOf(collection.fields),
        new Date(),
      );
      return c.json({ data });
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
      const { field, value } = (await readJson(c.req)) as { field?: string; value?: string };
      if (!field) throw new AppError("VALIDATION", "`field` is required");
      const valid = await verifyHashField(
        ctx,
        collection,
        { userId: auth.userId, tenantId: auth.tenantId, roles: auth.roles },
        { whereSql: perm.whereSql, fields: perm.fields, conditions: perm.conditions },
        id,
        field,
        value,
        requestMeta(c.req.raw),
      );
      return c.json({ valid });
    },
  );
