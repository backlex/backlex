/**
 * The incremental changefeed — one page of rows changed past a keyset cursor.
 *
 * This is the shared implementation behind every surface that exposes the feed
 * (REST `GET /:slug/changes`, the `changes<Collection>` GraphQL query, the
 * `collections-changes` MCP tool, `backlex items changes`). Permission, tenant
 * and draft guards live here exactly once, so a new surface can't accidentally
 * ship a weaker version of them.
 *
 * See `docs/offline-sync.md` for the client-side contract.
 */

import { AppError, type AuthSubject } from "@backlex/core";
import { sql } from "drizzle-orm";
import type { Ctx } from "../../context";
import type { CollectionRow } from "./collection-loader";
import { deserializeRow } from "./serialize";
import {
  draftFilter,
  fromOf,
  physicalSystemCol,
  queryAll,
  selectStar,
  tenantFilter,
  whereOf,
} from "./sql-helpers";
import { parseShape, shapeKey } from "./shape";

/** SELECT-list alias carrying shape membership for the row. Stripped before the
 *  row is serialized — it's transport, not data. */
const IN_SHAPE = "_in_shape";

/** Dialect-tolerant truthiness for the membership flag: Postgres hands back a
 *  boolean/number, D1 and libSQL can hand back `1` or `"1"`. */
const isTruthy = (v: unknown): boolean => v === 1 || v === true || v === "1";

export interface ChangefeedParams {
  ctx: Ctx;
  auth: AuthSubject;
  collection: CollectionRow;
  /** The caller's resolved read permission (row filter + field allow-list). */
  perm: { whereSql: unknown; fields: Set<string> | null };
  /** Whether the caller may see unpublished rows (resolved by the surface). */
  canSeeDrafts: boolean;
  since?: string;
  limit?: number;
  /** JSON filter naming the subset to replicate. */
  shape?: string;
  /** Comma-separated projection. */
  fields?: string;
  /** Draft/publish status filter, passed through to `draftFilter`. */
  status?: string;
}

export interface ChangefeedPage {
  data: Record<string, unknown>[];
  cursor: string | null;
  hasMore: boolean;
  shape?: string;
}

/**
 * Epoch ms for a row's `updated_at`, whatever the driver handed back.
 *
 * SQLite stores it as an integer and drizzle returns a number or a `Date`.
 * Postgres returns a `timestamptz`, and depending on the driver that arrives as
 * a `Date` OR as the string `2026-08-10 00:45:25.406+00` — which is not ISO
 * 8601 (a space instead of `T`, a two-digit offset), so neither `Number()` nor
 * a bare `Date.parse` reads it.
 *
 * The previous `Number(raw)` produced `NaN` for that string, so every Postgres
 * deployment emitted the cursor `NaN.<id>`; the client stored it, sent it back,
 * and its next sync was refused as an invalid cursor — for good, since there is
 * nothing else to send. Found by a CDC sink, which is the first caller that
 * PERSISTS a cursor and hands it back on a later request.
 */
const updatedAtMs = (raw: unknown): number | null => {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const asNumber = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(asNumber)) return asNumber;
  // Normalize the Postgres text form into something `Date.parse` accepts on
  // every engine: `T` between date and time, and a two-digit offset widened to
  // `+00:00`.
  const iso = raw
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
};

export const runChangefeed = async (params: ChangefeedParams): Promise<ChangefeedPage> => {
  const { ctx, auth, collection, perm } = params;
  const updatedCol = physicalSystemCol(collection, "updated_at");
  if (!updatedCol) {
    throw new AppError("VALIDATION", "Collection has no updated_at column — changefeed unavailable");
  }
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);

  // Cursor = base64url("<updatedAtMs>.<id>"). Absent → full sync from epoch.
  let sinceMs = 0;
  let sinceId = "";
  if (params.since) {
    try {
      const dec = Buffer.from(params.since, "base64url").toString("utf8");
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
  const sinceLit =
    ctx.dialect === "pg" ? sql`${new Date(sinceMs).toISOString()}::timestamptz` : sql`${sinceMs}`;
  const keyset =
    sinceMs > 0 || sinceId
      ? sql`(${col} > ${sinceLit} OR (${col} = ${sinceLit} AND ${pkCol} > ${sinceId}))`
      : null;
  const tenantWhere = tenantFilter(collection, auth);
  const draftWhere = draftFilter(collection, params.canSeeDrafts, params.status);

  // A shape narrows *replication*, not visibility — it is evaluated as a
  // SELECT-list expression rather than a WHERE clause so rows that fell out of
  // the shape still come back (flagged `_shape_exit`) and the client can drop
  // them. Filtering them out in WHERE would make a row that stopped matching
  // indistinguishable from one that never changed, and the client would hold a
  // stale copy forever.
  const shape = parseShape(params.shape, collection, auth, perm.fields, ctx.dialect);
  const membership = shape
    ? sql`, (CASE WHEN ${shape.membershipSql} THEN 1 ELSE 0 END) AS ${sql.identifier(IN_SHAPE)}`
    : sql``;

  // NOTE: deletedFilter is intentionally omitted — tombstones must flow.
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(collection)}${membership} FROM ${fromOf(collection)} ${whereOf(keyset, perm.whereSql as never, tenantWhere, draftWhere)} ORDER BY ${col} ASC, ${pkCol} ASC LIMIT ${limit + 1}`,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  let cursor: string | null = null;
  if (last) {
    const ms = updatedAtMs(last[updatedCol]);
    // A cursor that cannot be decoded is worse than no cursor: the client
    // stores it, sends it back, and every subsequent sync 422s with nothing to
    // fall back to. `null` means "start over", which is recoverable.
    cursor =
      ms === null
        ? null
        : Buffer.from(`${ms}.${String(last[collection.pkColumn])}`, "utf8").toString("base64url");
  }

  // Projection: `fields` narrows what travels over the wire. `id` and
  // `updated_at` are non-negotiable additions — the client keys its store on one
  // and its cursor on the other. Fields the permission row hides are dropped by
  // `deserializeRow` regardless of what was asked for.
  const projection = params.fields
    ? [
        ...new Set(
          params.fields
            .split(",")
            .map((f) => f.trim())
            .filter((f) => f && (!perm.fields || perm.fields.has(f)))
            .concat(["id", "updated_at"]),
        ),
      ]
    : null;

  const data = page.map((r) => {
    const inShape = shape ? r[IN_SHAPE] : 1;
    delete r[IN_SHAPE];
    // Left the shape: send the id and nothing else. The row is still readable
    // (permissions passed) — it just isn't this client's business anymore, so
    // shipping its columns would be pointless bytes at best.
    if (shape && !isTruthy(inShape)) {
      return { id: r[collection.pkColumn] ?? r.id, _shape_exit: true };
    }
    const row = deserializeRow(r, collection.fields, ctx.dialect, collection.ownerScoped, projection);
    // `deserializeRow` drops `deleted_at`; surface a tombstone marker so a sync
    // client can drop the row from its local store.
    if (r.deleted_at != null) row._deleted = true;
    return row;
  });

  return { data, cursor, hasMore, ...(shape ? { shape: shapeKey(shape.condition) } : {}) };
};
