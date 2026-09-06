/**
 * Advisor v2 — runtime query insights.
 *
 * The advisor's original performance rules are *static*: they read the index
 * catalog and flag hot paths the schema implies. This module adds the other
 * half — what the workspace's traffic actually did — by aggregating the
 * `spans` rows the request middleware already writes.
 *
 * Two rollups come out of one pass over the window:
 *
 *  - **per endpoint** — requests grouped by `METHOD /route/pattern`, with
 *    latency percentiles and the error share. Concrete ids in the path are
 *    folded to `:id` so `/api/items/posts/<uuid>` and `/api/items/posts/<uuid2>`
 *    are one endpoint; the collection slug is deliberately NOT folded, since
 *    "which collection is slow" is the question being asked.
 *  - **per collection** — list traffic plus how often each local column was
 *    filtered / sorted on, read from the `queryShape` attributes the list
 *    handler records. This is what turns "you have no index on `status`" into
 *    "84% of the 1,240 list requests on `posts` filter by `status`".
 *
 * Honesty rules this file keeps:
 *  - Percentiles are computed over the spans that were actually stored. When
 *    `TRACES_SAMPLE_RATE` < 1 the window is a sample, so `sampleRate` rides
 *    along on the result and every consumer says so.
 *  - Nothing is extrapolated. `requests` is the number of spans seen, not an
 *    estimate of the true request count.
 *  - Spans are pruned on a retention schedule, so a window longer than the
 *    retention silently sees less data. `spanCount` + `oldestSpanAt` let a
 *    caller notice that instead of over-reading a short history.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { Env } from "../env";
import { traceSampleRate } from "./traces";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.spans : sqlite.schema.spans;

/** Hard cap on spans pulled into memory for one aggregation. A busy workspace
 *  can hold far more than this in the window; we take the most recent slice and
 *  report `truncated` so the caller can say the window was narrowed rather than
 *  quietly presenting a partial picture as complete. */
const MAX_SPANS = 20_000;

export interface EndpointStat {
  /** `GET /api/items/posts/:id` — method + normalized route pattern. */
  route: string;
  method: string;
  path: string;
  /** Spans seen for this endpoint in the window (not extrapolated). */
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  /** Mean duration, rounded to the nearest ms. */
  avgMs: number;
  /** Responses with status ≥ 500. */
  serverErrors: number;
  /** Responses with status in [400, 500). */
  clientErrors: number;
  /** `serverErrors / requests`, 0..1. */
  errorRate: number;
}

export interface CollectionColumnUse {
  column: string;
  /** List requests whose query touched this column. */
  requests: number;
  /** `requests / listRequests` for the collection, 0..1. */
  share: number;
}

export interface CollectionStat {
  collection: string;
  /** List requests recorded for this collection in the window. */
  listRequests: number;
  p50: number;
  p95: number;
  /** Columns appearing in the filter, most-used first. */
  filters: CollectionColumnUse[];
  /** Columns appearing in the sort, most-used first. */
  sorts: CollectionColumnUse[];
}

export interface PermissionWriteCheckStat {
  collection: string;
  /** `create` / `update` / … — the permission action the write was judged on. */
  action: string;
  /** Requests in the window carrying at least one such write. One per REQUEST,
   *  not per row: a 5,000-row import that misses the same condition every time
   *  is one span and therefore one here. */
  requests: number;
  /** True when at least one was recorded under `PERMISSION_WRITE_CHECK=enforce`
   *  — i.e. actually refused, not merely counted. */
  refused: boolean;
}

export interface RuntimeInsights {
  /** Endpoints ordered by p95 desc — the slow ones first. */
  endpoints: EndpointStat[];
  /** Collections ordered by list traffic desc. */
  collections: CollectionStat[];
  /** Writes that fell outside a `write` permission's conditions, busiest first.
   *  Empty means no recorded write in the window would have been refused —
   *  which is the reading `PERMISSION_WRITE_CHECK=warn` exists to produce, and
   *  is only as strong as `window.sampleRate`. */
  permissionWriteChecks: PermissionWriteCheckStat[];
  window: {
    /** Inclusive lower bound of the window (epoch ms). */
    from: number;
    /** When the aggregation ran (epoch ms). */
    to: number;
    days: number;
    /** Spans aggregated. */
    spanCount: number;
    /** Start of the oldest span seen, or null when the window is empty. Well
     *  after `from` means span retention, not traffic, bounded the window. */
    oldestSpanAt: number | null;
    /** `TRACES_SAMPLE_RATE`, 0..1. Below 1 the numbers describe a sample. */
    sampleRate: number;
    /** True when the window held more than `MAX_SPANS` spans and only the most
     *  recent were aggregated. */
    truncated: boolean;
  };
}

/** Path segments that are values rather than route structure. Ids come in
 *  several shapes here: UUIDs, ULID/nanoid-ish tokens, plain integers, and the
 *  32-hex trace ids. Everything else is treated as a literal route segment. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const INT_RE = /^\d+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;

const isIdSegment = (seg: string): boolean =>
  UUID_RE.test(seg) || HEX_RE.test(seg) || INT_RE.test(seg) || TOKEN_RE.test(seg);

/**
 * Fold a concrete request path into a route pattern.
 *
 * The first segment after a collection-addressing prefix is the collection
 * slug and is KEPT — the whole point is per-collection attribution. Every
 * later id-shaped segment becomes `:id`.
 *
 *   /api/items/posts/9f2c…      → /api/items/posts/:id
 *   /api/items/posts            → /api/items/posts
 *   /api/storage/files/abc123…  → /api/storage/files/:id
 */
export const normalizeRoutePath = (path: string): string => {
  const segs = path.split("/");
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) {
      out.push(seg ?? "");
      continue;
    }
    // Keep the slug immediately after `/api/items` (and its GraphQL-ish
    // siblings) so per-collection rows stay distinct.
    const prev = out[out.length - 1];
    const isCollectionSlot =
      (prev === "items" || prev === "collections") && out[out.length - 2] === "api";
    out.push(isCollectionSlot ? seg : isIdSegment(seg) ? ":id" : seg);
  }
  return out.join("/") || "/";
};

/** The collection slug a normalized items path addresses, or null. */
export const collectionFromPath = (path: string): string | null => {
  const m = /^\/api\/(?:items|collections)\/([^/]+)/.exec(path);
  const slug = m?.[1];
  if (!slug || slug === ":id") return null;
  return slug;
};

/** Nearest-rank percentile over an ascending array. `p` is 0..1. */
const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? 0;
};

interface RawSpan {
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  startedAt: number;
  attributes: Record<string, unknown> | null;
}

/** Read a string array out of a span attribute (JSON round-trips as unknown). */
const attrStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

interface EndpointAcc {
  method: string;
  path: string;
  durations: number[];
  total: number;
  serverErrors: number;
  clientErrors: number;
  sum: number;
  max: number;
}

interface CollectionAcc {
  durations: number[];
  listRequests: number;
  filters: Map<string, number>;
  sorts: Map<string, number>;
}

export interface InsightsCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
  env: Env;
}

export interface InsightsOpts {
  /** Window length in days. Clamped to 1..90. */
  days?: number;
  /** Max endpoint rows returned (slowest first). Clamped to 1..200. */
  limit?: number;
}

/**
 * Aggregate the workspace's recorded spans into endpoint + collection rollups.
 * Tenant-scoped; `tenantId === null` aggregates the whole instance (single-tenant
 * deploys). Never throws on a missing `spans` table — an unmigrated deployment
 * gets an empty window rather than a failed advisor run.
 */
export const loadRuntimeInsights = async (
  ctx: InsightsCtx,
  tenantId: string | null,
  opts: InsightsOpts = {},
): Promise<RuntimeInsights> => {
  const days = Math.min(90, Math.max(1, Math.floor(opts.days ?? 7)));
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const to = Date.now();
  const from = to - days * 24 * 60 * 60 * 1000;
  const sampleRate = traceSampleRate(ctx.env);

  const empty: RuntimeInsights = {
    endpoints: [],
    collections: [],
    permissionWriteChecks: [],
    window: {
      from,
      to,
      days,
      spanCount: 0,
      oldestSpanAt: null,
      sampleRate,
      truncated: false,
    },
  };

  const t = tableFor(ctx.dialect);
  let rows: RawSpan[];
  try {
    const conds = [gte(t.startedAt, new Date(from))] as any[];
    if (tenantId !== null) conds.push(eq(t.tenantId, tenantId));
    const raw = await (ctx.db as any)
      .select({
        method: t.method,
        path: t.path,
        status: t.status,
        durationMs: t.durationMs,
        startedAt: t.startedAt,
        attributes: t.attributes,
      })
      .from(t)
      .where(and(...conds))
      .orderBy(desc(t.startedAt))
      .limit(MAX_SPANS + 1);
    rows = (raw as any[]).map((r) => ({
      method: r.method ?? null,
      path: r.path ?? null,
      status: r.status ?? null,
      durationMs: r.durationMs ?? null,
      startedAt:
        r.startedAt instanceof Date ? r.startedAt.getTime() : Number(r.startedAt),
      attributes: (r.attributes as Record<string, unknown> | null) ?? null,
    }));
  } catch {
    // `spans` not migrated (or introspection failed) — report an empty window
    // rather than failing the whole advisor run.
    return empty;
  }

  const truncated = rows.length > MAX_SPANS;
  if (truncated) rows = rows.slice(0, MAX_SPANS);
  if (rows.length === 0) return empty;

  const byEndpoint = new Map<string, EndpointAcc>();
  const byCollection = new Map<string, CollectionAcc>();
  const byWriteCheck = new Map<string, PermissionWriteCheckStat>();
  let oldestSpanAt = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (row.startedAt < oldestSpanAt) oldestSpanAt = row.startedAt;
    const path = row.path;
    if (!path) continue;
    const method = row.method ?? "GET";
    const pattern = normalizeRoutePath(path);
    const key = `${method} ${pattern}`;
    let acc = byEndpoint.get(key);
    if (!acc) {
      acc = {
        method,
        path: pattern,
        durations: [],
        total: 0,
        serverErrors: 0,
        clientErrors: 0,
        sum: 0,
        max: 0,
      };
      byEndpoint.set(key, acc);
    }
    acc.total++;
    const ms = row.durationMs;
    if (typeof ms === "number" && Number.isFinite(ms)) {
      acc.durations.push(ms);
      acc.sum += ms;
      if (ms > acc.max) acc.max = ms;
    }
    const status = row.status ?? 0;
    if (status >= 500) acc.serverErrors++;
    else if (status >= 400) acc.clientErrors++;

    const attrs = row.attributes;

    // Writes that fell outside a `write` permission's conditions, recorded as
    // `collection:action:mode`. These ride on POST/PATCH spans, which carry no
    // `queryShape` — so this has to be read BEFORE the per-collection rollup's
    // `continue`, or the rule would see nothing and read as a clean bill.
    for (const entry of attrStrings(attrs?.permissionWriteChecks)) {
      const [col, action, mode] = entry.split(":");
      if (!col || !action) continue;
      const key = `${col}:${action}`;
      let wacc = byWriteCheck.get(key);
      if (!wacc) {
        wacc = { collection: col, action, requests: 0, refused: false };
        byWriteCheck.set(key, wacc);
      }
      wacc.requests++;
      if (mode === "enforce") wacc.refused = true;
    }

    // Per-collection rollup — only list requests carry a `queryShape`, which is
    // exactly the traffic the index rules reason about.
    const collection =
      typeof attrs?.collection === "string" ? attrs.collection : null;
    if (!collection) continue;
    let cacc = byCollection.get(collection);
    if (!cacc) {
      cacc = { durations: [], listRequests: 0, filters: new Map(), sorts: new Map() };
      byCollection.set(collection, cacc);
    }
    cacc.listRequests++;
    if (typeof ms === "number" && Number.isFinite(ms)) cacc.durations.push(ms);
    for (const col of attrStrings(attrs?.filters)) {
      cacc.filters.set(col, (cacc.filters.get(col) ?? 0) + 1);
    }
    for (const col of attrStrings(attrs?.sorts)) {
      cacc.sorts.set(col, (cacc.sorts.get(col) ?? 0) + 1);
    }
  }

  const endpoints: EndpointStat[] = [];
  for (const [route, acc] of byEndpoint) {
    const sorted = [...acc.durations].sort((a, b) => a - b);
    endpoints.push({
      route,
      method: acc.method,
      path: acc.path,
      requests: acc.total,
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
      p99: Math.round(percentile(sorted, 0.99)),
      maxMs: Math.round(acc.max),
      avgMs: sorted.length ? Math.round(acc.sum / sorted.length) : 0,
      serverErrors: acc.serverErrors,
      clientErrors: acc.clientErrors,
      errorRate: acc.total ? acc.serverErrors / acc.total : 0,
    });
  }
  // Slowest first; ties broken by traffic so a busy endpoint outranks a quiet
  // one at the same latency.
  endpoints.sort((a, b) => b.p95 - a.p95 || b.requests - a.requests);

  const toColumnUse = (
    counts: Map<string, number>,
    total: number,
  ): CollectionColumnUse[] =>
    [...counts.entries()]
      .map(([column, requests]) => ({
        column,
        requests,
        share: total ? requests / total : 0,
      }))
      .sort((a, b) => b.requests - a.requests || a.column.localeCompare(b.column));

  const collections: CollectionStat[] = [];
  for (const [collection, acc] of byCollection) {
    const sorted = [...acc.durations].sort((a, b) => a - b);
    collections.push({
      collection,
      listRequests: acc.listRequests,
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
      filters: toColumnUse(acc.filters, acc.listRequests),
      sorts: toColumnUse(acc.sorts, acc.listRequests),
    });
  }
  collections.sort(
    (a, b) =>
      b.listRequests - a.listRequests || a.collection.localeCompare(b.collection),
  );

  const permissionWriteChecks = [...byWriteCheck.values()].sort(
    (a, b) =>
      b.requests - a.requests ||
      a.collection.localeCompare(b.collection) ||
      a.action.localeCompare(b.action),
  );

  return {
    endpoints: endpoints.slice(0, limit),
    collections,
    permissionWriteChecks,
    window: {
      from,
      to,
      days,
      spanCount: rows.length,
      oldestSpanAt: Number.isFinite(oldestSpanAt) ? oldestSpanAt : null,
      sampleRate,
      truncated,
    },
  };
};
