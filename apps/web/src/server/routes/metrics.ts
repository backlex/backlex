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
    const rows = await queryAll<{ action: string; created_at: number | string; tenant_id: string | null }>(
      { db: ctx.db, dialect: ctx.dialect },
      sql.raw(
        `SELECT action, created_at, tenant_id FROM activity ${
          auth.tenantId ? `WHERE tenant_id = '${auth.tenantId.replace(/'/g, "''")}' OR tenant_id IS NULL` : ""
        } ORDER BY created_at DESC LIMIT 5000`,
      ),
    );

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
        },
        counts,
      },
    });
  });
