import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
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

/**
 * Overview-page metrics. Everything we expose is derived from `activity`
 * rows the API writes on every mutating request — there's no separate
 * analytics pipeline. For mature deploys this can move to CF Analytics
 * Engine; for now this is enough to power the four cards + sparklines.
 */
export const metricsRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .get("/overview", async (c) => {
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
    }>(
      { db: ctx.db, dialect: ctx.dialect },
      sql.raw(
        `SELECT action, created_at, tenant_id, duration_ms, collection, item_id, user_id FROM activity ${
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
      if (/error|fail|denied/.test(r.action)) {
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

    // Resource counts — design's middle row tiles.
    const counts: Record<string, number> = {
      collections: 0,
      files: 0,
      flows: 0,
      functions: 0,
      activeFlows: 0,
      pausedFlows: 0,
    };
    for (const t of ["collections", "files", "flows", "functions"] as const) {
      try {
        const r = await queryAll<{ n: number }>(
          { db: ctx.db, dialect: ctx.dialect },
          sql.raw(`SELECT COUNT(*) AS n FROM ${t}`),
        );
        counts[t] = Number(r[0]?.n ?? 0);
      } catch {
        // table missing
      }
    }
    try {
      const fa = await queryAll<{ n: number }>(
        { db: ctx.db, dialect: ctx.dialect },
        sql.raw(`SELECT COUNT(*) AS n FROM flows WHERE active = 1`),
      );
      counts.activeFlows = Number(fa[0]?.n ?? 0);
    } catch {}
    counts.pausedFlows = Math.max(0, (counts.flows ?? 0) - (counts.activeFlows ?? 0));

    // Top collections — for each `collections` row, COUNT(*) + MAX(updated_at)
    // on its physical c_<slug> table. Cheap on the dev set; cap at 10.
    const topCollections: { slug: string; rows: number; bytes: number; lastWrite: number | null }[] = [];
    try {
      const cs = await queryAll<{ slug: string }>(
        { db: ctx.db, dialect: ctx.dialect },
        sql.raw(`SELECT slug FROM collections ORDER BY slug LIMIT 10`),
      );
      for (const c of cs) {
        try {
          const r = await queryAll<{ n: number; m: number | string | null }>(
            { db: ctx.db, dialect: ctx.dialect },
            sql.raw(`SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM "c_${c.slug.replace(/"/g, "")}"`),
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
                sql.raw(`SELECT pg_total_relation_size('"c_${c.slug.replace(/"/g, "")}"') AS s`),
              );
              if (sz[0]?.s != null) bytes = Number(sz[0].s);
            } catch {}
          }
          topCollections.push({ slug: c.slug, rows: rowCount, bytes, lastWrite });
        } catch {
          topCollections.push({ slug: c.slug, rows: 0, bytes: 0, lastWrite: null });
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
    }));

    // Recent errors — same source, but filtered by name pattern. We bucket
    // by action/resource and emit the top 5 with their counts.
    const errBuckets = new Map<string, { code: string; resource: string; msg: string; count: number; last: number }>();
    for (const r of rows) {
      if (!/error|fail|denied/.test(r.action)) continue;
      const key = r.action;
      const ts = typeof r.created_at === "number" ? r.created_at : new Date(r.created_at).getTime();
      const cur = errBuckets.get(key);
      if (cur) {
        cur.count += 1;
        if (ts > cur.last) cur.last = ts;
      } else {
        errBuckets.set(key, { code: "ERR", resource: r.action, msg: r.action, count: 1, last: ts });
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
  })
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
  .get("/entities", async (c) => {
    const ctx = c.get("ctx");
    const dialectIs = ctx.dialect;

    const flows: Record<string, { runs: number; lastRun: number | null }> = {};
    const functions: Record<string, { invocations: number; p95Ms: number; lastInvoke: number | null }> = {};
    const webhooks: Record<string, { deliveries: number; lastDelivery: number | null }> = {};

    // Flow runs — one row per `flow.run` activity entry.
    try {
      const rows = await queryAll<{ item_id: string; n: number; last: number | string | null }>(
        { db: ctx.db, dialect: dialectIs },
        sql.raw(`SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last FROM activity WHERE collection = 'system_flows' AND action = 'run' GROUP BY item_id`),
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
        sql.raw(`SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last, ${concatExpr} AS durations FROM activity WHERE collection = 'system_functions' AND action = 'invoke' GROUP BY item_id`),
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
        sql.raw(`SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last FROM activity WHERE collection = 'system_webhooks' AND action IN ('test', 'delivery') GROUP BY item_id`),
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
  });
