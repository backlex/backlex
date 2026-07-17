import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { SECURITY, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  loadCollection,
} from "../../services/items/collection-loader";
import {
  deserializeRow,
} from "../../services/items/serialize";
import {
  draftFilter,
  fromOf,
  physicalSystemCol,
  queryAll,
  selectStar,
  tenantFilter,
  whereOf,
} from "../../services/items/sql-helpers";
import {
  ItemRow,
  TAGS,
} from "../../services/items/schemas";
import { canSeeDraftsFor } from "./shared";
import { defaultHook } from "../../lib/openapi-router";

export const itemsChangesRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/changes",
      tags: TAGS,
      summary: "Incremental changes (offline sync)",
      description:
        "Rows changed since the `since` cursor, including soft-deleted tombstones, keyset-paginated on (updated_at, id). Use the returned `cursor` for the next page.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({
          since: z.string().optional().openapi({ description: "Opaque cursor from a prior response (omit for a full initial sync)." }),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          description: "Changes",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(ItemRow), cursor: z.string().nullable(), hasMore: z.boolean() }),
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
      const updatedCol = physicalSystemCol(collection, "updated_at");
      if (!updatedCol) {
        throw new AppError("VALIDATION", "Collection has no updated_at column — changefeed unavailable");
      }
      const q = c.req.valid("query");
      const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
      // Cursor = base64url("<updatedAtMs>.<id>"). Absent → full sync from epoch.
      let sinceMs = 0;
      let sinceId = "";
      if (q.since) {
        try {
          const dec = Buffer.from(q.since, "base64url").toString("utf8");
          const dot = dec.indexOf(".");
          sinceMs = Number(dec.slice(0, dot));
          sinceId = dec.slice(dot + 1);
          if (!Number.isFinite(sinceMs)) throw new Error("bad");
        } catch {
          throw new AppError("VALIDATION", "Invalid `since` cursor");
        }
      }
      const col = sql`${sql.identifier(updatedCol)}`;
      const pkCol = sql`${sql.identifier(collection.pkColumn)}`;
      // Dual-dialect cursor literal: sqlite stores updated_at as epoch ms; pg as
      // timestamptz (compare against an ISO cast).
      const sinceLit = ctx.dialect === "pg" ? sql`${new Date(sinceMs).toISOString()}::timestamptz` : sql`${sinceMs}`;
      const keyset =
        sinceMs > 0 || sinceId
          ? sql`(${col} > ${sinceLit} OR (${col} = ${sinceLit} AND ${pkCol} > ${sinceId}))`
          : null;
      const tenantWhere = tenantFilter(collection, auth);
      const draftWhere = draftFilter(
        collection,
        await canSeeDraftsFor(ctx, auth, collection, perm),
        c.req.query("status"),
      );
      // NOTE: deletedFilter is intentionally omitted — tombstones must flow.
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(keyset, perm.whereSql, tenantWhere, draftWhere)} ORDER BY ${col} ASC, ${pkCol} ASC LIMIT ${limit + 1}`,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      let cursor: string | null = null;
      if (last) {
        const rawUpdated = last[updatedCol];
        const ms = rawUpdated instanceof Date ? rawUpdated.getTime() : Number(rawUpdated);
        cursor = Buffer.from(`${ms}.${String(last[collection.pkColumn])}`, "utf8").toString("base64url");
      }
      const data = page.map((r) => {
        const row = deserializeRow(r, collection.fields, ctx.dialect, collection.ownerScoped);
        // `deserializeRow` drops `deleted_at`; surface a tombstone marker so a
        // sync client can drop the row from its local store.
        if (r.deleted_at != null) row._deleted = true;
        return row;
      });
      return c.json({ data, cursor, hasMore });
    },
  )
  /** Full revision (change) history for one item — newest first. Read-gated. */
;
