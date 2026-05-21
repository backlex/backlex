import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

interface MetricsBucket {
  ts: number;
  requests: number;
  errors: number;
}

const queryAll = async <T>(
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  raw: ReturnType<typeof sql.raw>,
): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = (await (ctx.db as any).execute(raw)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return (r as { rows: T[] }).rows;
    return r as T[];
  }
  return (await (ctx.db as any).all(raw)) as T[];
};

const RANGE_TO_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// Activity rows that are bookkeeping for a *system* surface — their payload
// is shaped by us, so an `error` marker there is a real failure. User
// collection writes store arbitrary item data as the payload, so a stray
// `error` field on those must NOT be mistaken for a failed request.
const SYSTEM_ACTIVITY_COLLECTIONS = new Set([
  "system_collections",
  "system_webhooks",
  "system_flows",
  "system_functions",
  "system_roles",
  "files",
  "http",
]);

// Raw SQL bypasses Drizzle's column codecs, so `payload` comes back as a JSON
// string on SQLite/D1 and as an already-parsed object on Postgres.
const parsePayload = (raw: unknown): Record<string, unknown> | null => {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
};

const isErrorRow = (
  action: string,
  collection: string | null,
  payload: Record<string, unknown> | null,
): boolean => {
  if (/error|fail|denied/i.test(action)) return true;
  if (!payload) return false;
  if (collection && !SYSTEM_ACTIVITY_COLLECTIONS.has(collection)) return false;
  if (payload.error != null && payload.error !== false && payload.error !== "") return true;
  if (payload.failed === true) return true;
  if (payload.ok === false) return true;
  return false;
};

const errorMessageOf = (
  payload: Record<string, unknown> | null,
  fallback: string,
): string => {
  const m = payload?.message ?? payload?.error;
  if (typeof m === "string" && m) return m;
  if (m != null) {
    try {
      return JSON.stringify(m);
    } catch {
      return String(m);
    }
  }
  return fallback;
};

const MetricsRange = z
  .enum(["15m", "1h", "24h", "7d", "30d"])
  .openapi({ description: "Sliding window for the overview metrics." });

const MetricsBucketSchema = z
  .object({
    ts: z.number().int().openapi({ description: "Unix seconds at the bucket start." }),
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .openapi("MetricsBucket");

const TopCollectionStat = z
  .object({
    slug: z.string(),
    rows: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    lastWrite: z.number().int().nullable(),
    writes24h: z.number().int().nonnegative(),
  })
  .openapi("TopCollectionStat");

const RecentLogRow = z
  .object({
    t: z.number().int(),
    action: z.string(),
    collection: z.string().optional(),
    itemId: z.string().optional(),
    userId: z.string().optional(),
    ms: z.number().int().optional(),
    error: z.boolean(),
  })
  .openapi("MetricsRecentLogRow");

const RecentErrorRow = z
  .object({
    code: z.string(),
    resource: z.string(),
    msg: z.string(),
    count: z.number().int().nonnegative(),
    last: z.number().int(),
  })
  .openapi("MetricsRecentErrorRow");

const OverviewResponse = z
  .object({
    range: z.string(),
    windowMs: z.number().int(),
    bucketMs: z.number().int(),
    series: z.array(MetricsBucketSchema),
    totals: z.object({
      requests: z.number().int(),
      errors: z.number().int(),
      errorRate: z.number(),
      activeUsers: z.number().int(),
      p95Ms: z.number(),
    }),
    counts: z.record(z.string(), z.number().int()),
    topCollections: z.array(TopCollectionStat),
    recent: z.array(RecentLogRow),
    recentErrors: z.array(RecentErrorRow),
  })
  .openapi("MetricsOverviewResponse");

const EntitiesResponse = z
  .object({
    flows: z.record(
      z.string(),
      z.object({ runs: z.number().int(), lastRun: z.number().int().nullable() }),
    ),
    functions: z.record(
      z.string(),
      z.object({
        invocations: z.number().int(),
        p95Ms: z.number().int(),
        lastInvoke: z.number().int().nullable(),
      }),
    ),
    webhooks: z.record(
      z.string(),
      z.object({
        deliveries: z.number().int(),
        lastDelivery: z.number().int().nullable(),
      }),
    ),
  })
  .openapi("MetricsEntitiesResponse");

const TAGS = ["metrics"];

/**
 * Overview-page metrics. Everything we expose is derived from `activity`
 * rows the API writes on every mutating request — there's no separate
 * analytics pipeline. For mature deploys this can move to CF Analytics
 * Engine; for now this is enough to power the four cards + sparklines.
 */
export const metricsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/overview",
      tags: TAGS,
      summary: "Overview metrics for the admin dashboard",
      description:
        "Bucketed request/error series + totals + per-collection stats. Derived from the `activity` table. Admin only.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: { query: z.object({ range: MetricsRange.optional() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.any() },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const range = c.req.query("range") ?? "1h";
      const windowMs = RANGE_TO_MS[range] ?? RANGE_TO_MS["1h"]!;
      const buckets = 40;
      const bucketMs = Math.max(windowMs / buckets, 1000);
      const now = Date.now();
      const start = now - windowMs;

      // Pull recent activity rows once, then bucket client-side. The set is
      // small for live workspaces; if it grows we can group in SQL.
      const rows = await queryAll<{
        action: string;
        created_at: number | string;
        tenant_id: string | null;
        duration_ms: number | null;
        collection: string | null;
        item_id: string | null;
        user_id: string | null;
        payload: unknown;
      }>(
        { db: ctx.db, dialect: ctx.dialect },
        sql.raw(
          `SELECT action, created_at, tenant_id, duration_ms, collection, item_id, user_id, payload FROM activity ${
            auth.tenantId ? `WHERE tenant_id = '${auth.tenantId.replace(/'/g, "''")}' OR tenant_id IS NULL` : ""
          } ORDER BY created_at DESC LIMIT 5000`,
        ),
      );

      // p95 latency over rows that recorded a duration. Computed via simple
      // percentile-of-sorted-array; cheap for the in-memory set.
      const durations: number[] = [];
      for (const r of rows) {
        const ts = typeof r.created_at === "number" ? r.created_at : new Date(r.created_at).getTime();
        if (ts < start) continue;
        if (typeof r.duration_ms === "number" && r.duration_ms > 0) durations.push(r.duration_ms);
      }
      durations.sort((a, b) => a - b);
      const p95Ms = durations.length
        ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
        : 0;

      const series: MetricsBucket[] = Array.from({ length: buckets }, (_, i) => ({
        ts: Math.floor((start + i * bucketMs) / 1000),
        requests: 0,
        errors: 0,
      }));
      let totalRequests = 0;
      let totalErrors = 0;
      const userSet = new Set<string>();

      for (const r of rows) {
        const ts = typeof r.created_at === "number" ? r.created_at : new Date(r.created_at).getTime();
        if (ts < start) continue;
        const idx = Math.min(buckets - 1, Math.floor((ts - start) / bucketMs));
        series[idx]!.requests += 1;
        totalRequests += 1;
        if (isErrorRow(r.action, r.collection, parsePayload(r.payload))) {
          series[idx]!.errors += 1;
          totalErrors += 1;
        }
      }

      // Active users in the window — distinct sessions whose createdAt fell
      // inside the range. Cheap on small DBs.
      try {
        const sessRows = await queryAll<{ user_id: string; created_at: number | string }>(
          { db: ctx.db, dialect: ctx.dialect },
          sql.raw(
            `SELECT user_id, created_at FROM sessions ORDER BY created_at DESC LIMIT 2000`,
          ),
        );
        for (const s of sessRows) {
          const ts = typeof s.created_at === "number" ? s.created_at : new Date(s.created_at).getTime();
          if (ts >= start) userSet.add(s.user_id);
        }
      } catch {
        // sessions table missing on dev; ignore
      }

      // Resource counts — design's middle row tiles. Every table here has
      // a `tenant_id` column, so scope counts to the active workspace.
      const counts: Record<string, number> = {
        collections: 0,
        files: 0,
        flows: 0,
        functions: 0,
        activeFlows: 0,
        pausedFlows: 0,
      };
      const tenantClause = auth.tenantId
        ? `WHERE tenant_id = '${auth.tenantId.replace(/'/g, "''")}'`
        : "";
      for (const t of ["collections", "files", "flows", "functions"] as const) {
        try {
          const r = await queryAll<{ n: number }>(
            { db: ctx.db, dialect: ctx.dialect },
            sql.raw(`SELECT COUNT(*) AS n FROM ${t} ${tenantClause}`),
          );
          counts[t] = Number(r[0]?.n ?? 0);
        } catch {
          // table missing
        }
      }
      try {
        const activeWhere = auth.tenantId
          ? `WHERE active = 1 AND tenant_id = '${auth.tenantId.replace(/'/g, "''")}'`
          : "WHERE active = 1";
        const fa = await queryAll<{ n: number }>(
          { db: ctx.db, dialect: ctx.dialect },
          sql.raw(`SELECT COUNT(*) AS n FROM flows ${activeWhere}`),
        );
        counts.activeFlows = Number(fa[0]?.n ?? 0);
      } catch {}
      counts.pausedFlows = Math.max(0, (counts.flows ?? 0) - (counts.activeFlows ?? 0));

      // Per-collection writes in the last 24h — counted from the activity rows
      // we already loaded. Only rows with a `collection` and a mutating action
      // qualify. Independent of the user-requested `range` (cards always show
      // 24h, even when the dashboard window is 1h/7d/etc.).
      const writes24hBySlug = new Map<string, number>();
      const day = now - 24 * 60 * 60 * 1000;
      for (const r of rows) {
        if (!r.collection) continue;
        if (!/^(create|update|delete|patch|insert)/i.test(r.action)) continue;
        const ts = typeof r.created_at === "number" ? r.created_at : new Date(r.created_at).getTime();
        if (ts < day) continue;
        writes24hBySlug.set(r.collection, (writes24hBySlug.get(r.collection) ?? 0) + 1);
      }

      // Per-collection stats — for each `collections` row in the active tenant,
      // COUNT(*) + MAX(updated_at) on the physical table named in
      // `physical_table`. Cheap on the dev set; returned for every collection so
      // the index page can render real numbers on every card.
      const topCollections: { slug: string; rows: number; bytes: number; lastWrite: number | null; writes24h: number }[] = [];
      try {
        const tenantClause = auth.tenantId
          ? `WHERE tenant_id = '${auth.tenantId.replace(/'/g, "''")}'`
          : "";
        const cs = await queryAll<{ slug: string; physical_table: string }>(
          { db: ctx.db, dialect: ctx.dialect },
          sql.raw(
            `SELECT slug, physical_table FROM collections ${tenantClause} ORDER BY slug`,
          ),
        );
        for (const c of cs) {
          const safeTable = (c.physical_table ?? "").replace(/"/g, "");
          const writes24h = writes24hBySlug.get(c.slug) ?? 0;
          if (!safeTable) continue;
          try {
            const r = await queryAll<{ n: number; m: number | string | null }>(
              { db: ctx.db, dialect: ctx.dialect },
              sql.raw(`SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM "${safeTable}"`),
            );
            const m = r[0]?.m;
            const lastWrite =
              typeof m === "number" ? m : m ? new Date(m).getTime() : null;
            const rowCount = Number(r[0]?.n ?? 0);
            // Cheap row-size estimate. PG: pg_total_relation_size when available;
            // SQLite/D1: fall back to rows × 256 bytes (median row width across
            // our default field types). Ugly but unblocks the UI.
            let bytes = rowCount * 256;
            if (ctx.dialect === "pg") {
              try {
                const sz = await queryAll<{ s: number }>(
                  { db: ctx.db, dialect: ctx.dialect },
                  sql.raw(`SELECT pg_total_relation_size('"${safeTable}"') AS s`),
                );
                if (sz[0]?.s != null) bytes = Number(sz[0].s);
              } catch {}
            }
            topCollections.push({ slug: c.slug, rows: rowCount, bytes, lastWrite, writes24h });
          } catch {
            topCollections.push({ slug: c.slug, rows: 0, bytes: 0, lastWrite: null, writes24h });
          }
        }
      } catch {}

      // Request log — last N activity rows verbatim. The UI converts these
      // into the design's "Time / Method / Path / Status / ms" row.
      const recent = rows.slice(0, 20).map((r) => ({
        t: typeof r.created_at === "number" ? r.created_at : new Date(r.created_at).getTime(),
        action: r.action,
        collection: r.collection ?? undefined,
        itemId: r.item_id ?? undefined,
        userId: r.user_id ?? undefined,
        ms: r.duration_ms ?? undefined,
        error: isErrorRow(r.action, r.collection, parsePayload(r.payload)),
      }));

      // Recent errors — same source, filtered to rows that actually represent a
      // failure (action name pattern, or an `error`/`failed`/`ok:false` marker on
      // a system-activity payload). Bucketed by action+code; the top 5 surface
      // with their counts, last-seen, and a human message pulled from the payload.
      const errBuckets = new Map<string, { code: string; resource: string; msg: string; count: number; last: number }>();
      for (const r of rows) {
        const payload = parsePayload(r.payload);
        if (!isErrorRow(r.action, r.collection, payload)) continue;
        const code = typeof payload?.code === "string" && payload.code ? payload.code : "ERR";
        const resource = r.collection
          ? `${r.collection}${r.item_id ? "/" + r.item_id : ""}`
          : r.action;
        const msg = errorMessageOf(payload, r.action);
        const key = `${r.action}::${code}`;
        const ts = typeof r.created_at === "number" ? r.created_at : new Date(r.created_at).getTime();
        const cur = errBuckets.get(key);
        if (cur) {
          cur.count += 1;
          if (ts > cur.last) {
            cur.last = ts;
            cur.resource = resource;
            cur.msg = msg;
          }
        } else {
          errBuckets.set(key, { code, resource, msg, count: 1, last: ts });
        }
      }
      const recentErrors = [...errBuckets.values()].sort((a, b) => b.last - a.last).slice(0, 5);

      return c.json({
        data: {
          range,
          windowMs,
          bucketMs,
          series,
          totals: {
            requests: totalRequests,
            errors: totalErrors,
            errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
            activeUsers: userSet.size,
            p95Ms,
          },
          counts,
          topCollections,
          recent,
          recentErrors,
        },
      });
    },
  )
  /**
   * Per-entity activity stats — turns the `runs: 4280`, `invocations: 1102`,
   * `deliveries: 184` placeholders on Flows/Functions/Webhooks pages into
   * actual numbers from the activity table. One round-trip serves all three
   * lists; the UI keys by id (flows/webhooks) or name (functions).
   *
   * Shape:
   *   {
   *     flows:     { [id]: { runs, lastRun }      },
   *     functions: { [name]: { invocations, p95Ms, lastInvoke } },
   *     webhooks:  { [id]: { deliveries, lastDelivery } },
   *   }
   */
  .openapi(
    createRoute({
      method: "get",
      path: "/entities",
      tags: TAGS,
      summary: "Per-entity activity stats (flows / functions / webhooks)",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: EntitiesResponse }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const dialectIs = ctx.dialect;
      const tenantAnd = auth.tenantId
        ? ` AND tenant_id = '${auth.tenantId.replace(/'/g, "''")}'`
        : "";

      const flows: Record<string, { runs: number; lastRun: number | null }> = {};
      const functions: Record<string, { invocations: number; p95Ms: number; lastInvoke: number | null }> = {};
      const webhooks: Record<string, { deliveries: number; lastDelivery: number | null }> = {};

      // Flow runs — one row per `flow.run` activity entry.
      try {
        const rows = await queryAll<{ item_id: string; n: number; last: number | string | null }>(
          { db: ctx.db, dialect: dialectIs },
          sql.raw(`SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last FROM activity WHERE collection = 'system_flows' AND action = 'flow.run'${tenantAnd} GROUP BY item_id`),
        );
        for (const r of rows) {
          if (!r.item_id) continue;
          flows[r.item_id] = {
            runs: Number(r.n),
            lastRun:
              typeof r.last === "number" ? r.last : r.last ? new Date(r.last).getTime() : null,
          };
        }
      } catch {}

      // Function invocations + p95 — itemId here is the function name.
      // GROUP_CONCAT is SQLite/D1; PG uses string_agg.
      const concatExpr = dialectIs === "pg"
        ? "string_agg(duration_ms::text, ',')"
        : "GROUP_CONCAT(duration_ms)";
      try {
        const rows = await queryAll<{ item_id: string; n: number; last: number | string | null; durations: string }>(
          { db: ctx.db, dialect: dialectIs },
          sql.raw(`SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last, ${concatExpr} AS durations FROM activity WHERE collection = 'system_functions' AND action = 'function.invoke'${tenantAnd} GROUP BY item_id`),
        );
        for (const r of rows) {
          if (!r.item_id) continue;
          const arr = String(r.durations ?? "")
            .split(",")
            .map((x) => Number(x))
            .filter((x) => Number.isFinite(x))
            .sort((a, b) => a - b);
          const p95 = arr.length ? arr[Math.floor(arr.length * 0.95)] ?? arr[arr.length - 1] ?? 0 : 0;
          functions[r.item_id] = {
            invocations: Number(r.n),
            p95Ms: Math.round(p95),
            lastInvoke:
              typeof r.last === "number" ? r.last : r.last ? new Date(r.last).getTime() : null,
          };
        }
      } catch {}

      // Webhook deliveries — counts both successful and test deliveries since
      // both fire the same physical request. The Webhooks page already has a
      // separate panel for delivery status detail.
      try {
        const rows = await queryAll<{ item_id: string; n: number; last: number | string | null }>(
          { db: ctx.db, dialect: dialectIs },
          sql.raw(`SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last FROM activity WHERE collection = 'system_webhooks' AND action IN ('webhook.test', 'webhook.delivery')${tenantAnd} GROUP BY item_id`),
        );
        for (const r of rows) {
          if (!r.item_id) continue;
          webhooks[r.item_id] = {
            deliveries: Number(r.n),
            lastDelivery:
              typeof r.last === "number" ? r.last : r.last ? new Date(r.last).getTime() : null,
          };
        }
      } catch {}

      return c.json({ data: { flows, functions, webhooks } });
    },
  );
