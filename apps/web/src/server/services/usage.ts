/**
 * Usage metering (#12) — the bridge between "measurement" and "enforcement".
 *
 * Request counts land in the per-day `usage_counters` ledger via a per-isolate
 * buffer: `bumpUsage` is called by the usage middleware on every metered
 * response and only touches memory; the buffer is flushed to the DB (a single
 * multi-row `ON CONFLICT … requests = requests + excluded.requests` upsert)
 * when it accumulates FLUSH_MAX_EVENTS events or turns FLUSH_MAX_AGE_MS old,
 * whichever comes first — so a busy isolate pays ~1 write per 20 requests
 * instead of 1 per request. The cron tick also flushes, so low-traffic
 * deployments don't sit on counts. Trade-off (same as `touchLastUsed`'s
 * debounce): an isolate evicted with a non-empty buffer under-counts by at
 * most one buffer's worth. Good enough for quotas; not a billing ledger.
 *
 * Monthly sums (quota checks) are read through a 60s per-isolate cache — a
 * quota is a monthly budget, so minute-level staleness is immaterial.
 *
 * Storage / row gauges are point-in-time measurements written by
 * `sweepUsageGauges` (cron, throttled) onto the current day's `api_key_id=''`
 * row — they answer "how big is this workspace right now", not "how much did
 * it grow today".
 */
import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Env } from "../env";
import {
  loadAppSettings,
  parseUsageLimits,
  type UsageLimits,
} from "./settings";

export interface UsageDbCtx {
  db: unknown;
  dialect: "pg" | "sqlite";
}

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.usageCounters : sqlite.schema.usageCounters;

/** UTC calendar day, `YYYY-MM-DD`. */
export const utcDay = (d: Date = new Date()): string => d.toISOString().slice(0, 10);

/** UTC month, `YYYY-MM`. */
export const utcMonth = (d: Date = new Date()): string => d.toISOString().slice(0, 7);

/* ── Write path: buffered per-isolate counters ─────────────────────────── */

interface BufferedEntry {
  tenantId: string;
  apiKeyId: string;
  day: string;
  requests: number;
  errors: number;
}

const FLUSH_MAX_EVENTS = 20;
const FLUSH_MAX_AGE_MS = 10_000;

let buffer = new Map<string, BufferedEntry>();
let bufferedEvents = 0;
let bufferedSince = 0;

/** Test hook — drop any buffered counts and cached sums/limits. */
export const resetUsageState = (): void => {
  buffer = new Map();
  bufferedEvents = 0;
  bufferedSince = 0;
  monthCache.clear();
  limitsCache.clear();
  rowsGaugeCache.clear();
};

/**
 * Record one metered response. Memory-only unless a flush threshold trips, in
 * which case the DB write is handed to `schedule` (waitUntil on Workers, a
 * dangling promise elsewhere) so it never blocks the response.
 */
export const bumpUsage = (
  ctx: UsageDbCtx,
  hit: { tenantId: string; apiKeyId?: string | null; error?: boolean },
  schedule: (work: Promise<unknown>) => void,
): void => {
  const day = utcDay();
  const apiKeyId = hit.apiKeyId ?? "";
  const key = `${hit.tenantId}\n${apiKeyId}\n${day}`;
  let entry = buffer.get(key);
  if (!entry) {
    entry = { tenantId: hit.tenantId, apiKeyId, day, requests: 0, errors: 0 };
    buffer.set(key, entry);
  }
  entry.requests += 1;
  if (hit.error) entry.errors += 1;
  bufferedEvents += 1;
  if (bufferedSince === 0) bufferedSince = Date.now();
  if (
    bufferedEvents >= FLUSH_MAX_EVENTS ||
    Date.now() - bufferedSince >= FLUSH_MAX_AGE_MS
  ) {
    schedule(flushUsage(ctx).catch(() => {}));
  }
};

/**
 * Drain the buffer into `usage_counters` as one multi-row upsert. Safe to call
 * on an empty buffer (no-op). Counts are taken out of the buffer *before* the
 * write so a concurrent bump during the await lands in a fresh buffer; if the
 * write itself fails the batch is dropped (best-effort — see module doc).
 */
export const flushUsage = async (ctx: UsageDbCtx): Promise<void> => {
  if (buffer.size === 0) return;
  const entries = [...buffer.values()];
  buffer = new Map();
  bufferedEvents = 0;
  bufferedSince = 0;
  const t = tableFor(ctx.dialect);
  const now = new Date();
  await (ctx.db as any)
    .insert(t)
    .values(
      entries.map((e) => ({
        tenantId: e.tenantId,
        apiKeyId: e.apiKeyId,
        day: e.day,
        requests: e.requests,
        errors: e.errors,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [t.tenantId, t.apiKeyId, t.day],
      set: {
        requests: sql`${t.requests} + excluded.requests`,
        errors: sql`${t.errors} + excluded.errors`,
        updatedAt: now,
      },
    });
};

/* ── Read path: monthly sums (quota checks) ────────────────────────────── */

const MONTH_CACHE_TTL_MS = 60_000;
const MONTH_CACHE_CAP = 5_000;
const monthCache = new Map<string, { value: number; at: number }>();

/**
 * Requests so far this UTC month — for one key (`apiKeyId` set) or the whole
 * workspace (`apiKeyId: null`). Cached per isolate for 60s: quota checks run
 * on the request hot path and a monthly budget doesn't need per-second truth.
 * The string range bound (`day >= 'YYYY-MM-01' AND day <= 'YYYY-MM-31'`)
 * deliberately avoids LIKE — D1 rejects bound LIKE patterns.
 */
export const monthUsage = async (
  ctx: UsageDbCtx,
  tenantId: string,
  apiKeyId: string | null,
): Promise<number> => {
  const month = utcMonth();
  const cacheKey = `${tenantId}\n${apiKeyId ?? "*"}\n${month}`;
  const hit = monthCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MONTH_CACHE_TTL_MS) return hit.value;
  const t = tableFor(ctx.dialect);
  const conds = [
    eq(t.tenantId, tenantId),
    gte(t.day, `${month}-01`),
    lte(t.day, `${month}-31`),
  ];
  if (apiKeyId !== null) conds.push(eq(t.apiKeyId, apiKeyId));
  const rows = (await (ctx.db as any)
    .select({ n: sql<number>`COALESCE(SUM(${t.requests}), 0)` })
    .from(t)
    .where(and(...conds))) as { n: number | string }[];
  const value = Number(rows[0]?.n ?? 0);
  if (monthCache.size >= MONTH_CACHE_CAP) monthCache.clear();
  monthCache.set(cacheKey, { value, at: Date.now() });
  return value;
};

/** Per-key request totals for the current UTC month (uncached — admin UI
 *  read, not a hot path). Key `""` is the session/no-key bucket. */
export const monthUsageByKey = async (
  ctx: UsageDbCtx,
  tenantId: string,
): Promise<Map<string, { requests: number; errors: number }>> => {
  const month = utcMonth();
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      apiKeyId: t.apiKeyId,
      requests: sql<number>`COALESCE(SUM(${t.requests}), 0)`,
      errors: sql<number>`COALESCE(SUM(${t.errors}), 0)`,
    })
    .from(t)
    .where(
      and(
        eq(t.tenantId, tenantId),
        gte(t.day, `${month}-01`),
        lte(t.day, `${month}-31`),
      ),
    )
    .groupBy(t.apiKeyId)) as {
    apiKeyId: string;
    requests: number | string;
    errors: number | string;
  }[];
  const out = new Map<string, { requests: number; errors: number }>();
  for (const r of rows) {
    out.set(r.apiKeyId, {
      requests: Number(r.requests),
      errors: Number(r.errors),
    });
  }
  return out;
};

/* ── Read path: admin series + gauges ──────────────────────────────────── */

export interface UsageCounterRow {
  apiKeyId: string;
  day: string;
  requests: number;
  errors: number;
  storageBytes: number | null;
  dbRows: number | null;
}

/** Raw ledger rows for the last `days` UTC days (inclusive of today),
 *  ordered by day. The route layer shapes these into series + per-key
 *  breakdowns — one query serves both. */
export const usageRows = async (
  ctx: UsageDbCtx,
  tenantId: string,
  days: number,
): Promise<UsageCounterRow[]> => {
  const t = tableFor(ctx.dialect);
  const start = utcDay(new Date(Date.now() - (days - 1) * 86_400_000));
  return (await (ctx.db as any)
    .select({
      apiKeyId: t.apiKeyId,
      day: t.day,
      requests: t.requests,
      errors: t.errors,
      storageBytes: t.storageBytes,
      dbRows: t.dbRows,
    })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), gte(t.day, start)))
    .orderBy(t.day)) as UsageCounterRow[];
};

/** Most recent storage/rows gauge for a workspace (nulls when the sweep has
 *  never run). Reads the newest `api_key_id=''` row that carries a gauge. */
export const latestGauges = async (
  ctx: UsageDbCtx,
  tenantId: string,
): Promise<{ storageBytes: number | null; dbRows: number | null; measuredAt: number | null }> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      storageBytes: t.storageBytes,
      dbRows: t.dbRows,
      updatedAt: t.updatedAt,
    })
    .from(t)
    .where(
      and(eq(t.tenantId, tenantId), eq(t.apiKeyId, ""), isNotNull(t.storageBytes)),
    )
    .orderBy(desc(t.day))
    .limit(1)) as {
    storageBytes: number | null;
    dbRows: number | null;
    updatedAt: Date | number;
  }[];
  const row = rows[0];
  if (!row) return { storageBytes: null, dbRows: null, measuredAt: null };
  return {
    storageBytes: row.storageBytes,
    dbRows: row.dbRows,
    measuredAt:
      row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
  };
};

/* ── Limits resolution ─────────────────────────────────────────────────── */

const envPosInt = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * Merge the platform env overrides (`USAGE_LIMIT_*` — how managed cloud
 * injects a tenant's plan) over the admin-editable `usageLimits` setting.
 * Env wins field-by-field wherever a key is present.
 */
export const resolveUsageLimits = (
  env: Env,
  settingsLimits: UsageLimits,
): UsageLimits => {
  const envMode =
    env.USAGE_LIMIT_MODE === "soft" ||
    env.USAGE_LIMIT_MODE === "hard" ||
    env.USAGE_LIMIT_MODE === "off"
      ? env.USAGE_LIMIT_MODE
      : null;
  return {
    mode: envMode ?? settingsLimits.mode,
    maxRequestsPerMonth:
      envPosInt(env.USAGE_LIMIT_REQUESTS_MONTH) ?? settingsLimits.maxRequestsPerMonth,
    maxStorageBytes:
      envPosInt(env.USAGE_LIMIT_STORAGE_BYTES) ?? settingsLimits.maxStorageBytes,
    maxDbRows: envPosInt(env.USAGE_LIMIT_DB_ROWS) ?? settingsLimits.maxDbRows,
  };
};

// Effective limits are consulted on the request hot path, so they ride a short
// per-isolate cache. 30s staleness on an admin edit is acceptable here (the
// admin UI reads limits through the route, not this cache) — the general
// "don't cache admin-editable data per isolate" rule trades off against a DB
// read per metered request, which this feature exists to avoid.
const LIMITS_CACHE_TTL_MS = 30_000;
const LIMITS_CACHE_CAP = 2_000;
const limitsCache = new Map<string, { value: UsageLimits; at: number }>();

export const effectiveUsageLimits = async (
  ctx: UsageDbCtx,
  env: Env,
  tenantId: string,
): Promise<UsageLimits> => {
  const hit = limitsCache.get(tenantId);
  if (hit && Date.now() - hit.at < LIMITS_CACHE_TTL_MS) return hit.value;
  const settings = await loadAppSettings(ctx.db as any, ctx.dialect, tenantId);
  const value = resolveUsageLimits(env, settings.usageLimits);
  if (limitsCache.size >= LIMITS_CACHE_CAP) limitsCache.clear();
  limitsCache.set(tenantId, { value, at: Date.now() });
  return value;
};

/** Drop the cached limits for a workspace — called by the limits PUT route so
 *  a save applies immediately on the isolate that served it. */
export const invalidateUsageLimits = (tenantId: string): void => {
  limitsCache.delete(tenantId);
};

/** Persist the admin-edited limits as the `usageLimits` app-setting. */
export const saveUsageLimits = async (
  ctx: UsageDbCtx,
  tenantId: string,
  limits: UsageLimits,
): Promise<void> => {
  const t =
    ctx.dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;
  const value = parseUsageLimits(limits);
  const updatedAt = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any)
    .insert(t)
    .values({ id: crypto.randomUUID(), tenantId, key: "usageLimits", value })
    .onConflictDoUpdate({
      target: [t.tenantId, t.key],
      set: { value, updatedAt },
    });
  invalidateUsageLimits(tenantId);
};

/* ── Admin overview (shared by REST / GraphQL / MCP / SDK / CLI) ───────── */

export interface UsageOverview {
  month: string;
  days: number;
  series: { day: string; requests: number; errors: number }[];
  monthTotals: { requests: number; errors: number };
  byKey: {
    id: string;
    name: string;
    prefix: string | null;
    revoked: boolean;
    rateLimitPerMinute: number | null;
    monthlyQuota: number | null;
    monthRequests: number;
    monthErrors: number;
  }[];
  gauges: { storageBytes: number | null; dbRows: number | null; measuredAt: number | null };
  limits: UsageLimits;
  settingsLimits: UsageLimits;
  envPinned: ("mode" | "maxRequestsPerMonth" | "maxStorageBytes" | "maxDbRows")[];
  over: ("requests" | "storage" | "rows")[];
}

/**
 * The one shared assembly every admin surface (REST, GraphQL, MCP; SDK/CLI
 * ride REST) uses — day series, per-key month totals, gauges, effective
 * limits + env pinning, and which dimensions are currently over budget.
 */
export const usageOverview = async (
  ctx: UsageDbCtx & { env: Env },
  tenantId: string,
  days: number,
  keys: {
    id: string;
    name: string;
    prefix: string;
    revokedAt: unknown;
    rateLimitPerMinute: number | null;
    monthlyQuota: number | null;
  }[],
): Promise<UsageOverview> => {
  const [rows, byKeyMonth, gauges, settings] = await Promise.all([
    usageRows(ctx, tenantId, days),
    monthUsageByKey(ctx, tenantId),
    latestGauges(ctx, tenantId),
    loadAppSettings(ctx.db as any, ctx.dialect, tenantId),
  ]);

  const byDay = new Map<string, { requests: number; errors: number }>();
  for (const r of rows) {
    const cur = byDay.get(r.day) ?? { requests: 0, errors: 0 };
    cur.requests += r.requests;
    cur.errors += r.errors;
    byDay.set(r.day, cur);
  }
  const series = [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  const keyById = new Map(keys.map((k) => [k.id, k]));
  const byKey: UsageOverview["byKey"] = [];
  const seen = new Set<string>();
  const pushKey = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const usage = byKeyMonth.get(id) ?? { requests: 0, errors: 0 };
    if (id === "") {
      byKey.push({
        id: "",
        name: "Sessions & admin",
        prefix: null,
        revoked: false,
        rateLimitPerMinute: null,
        monthlyQuota: null,
        monthRequests: usage.requests,
        monthErrors: usage.errors,
      });
      return;
    }
    const key = keyById.get(id);
    byKey.push({
      id,
      name: key?.name ?? "(deleted key)",
      prefix: key?.prefix ?? null,
      revoked: Boolean(key?.revokedAt),
      rateLimitPerMinute: key?.rateLimitPerMinute ?? null,
      monthlyQuota: key?.monthlyQuota ?? null,
      monthRequests: usage.requests,
      monthErrors: usage.errors,
    });
  };
  // Session bucket first; then keys with usage this month; then live keys
  // with no usage yet (so a freshly quota'd key still shows its budget).
  pushKey("");
  for (const id of byKeyMonth.keys()) pushKey(id);
  for (const k of keys) if (!k.revokedAt) pushKey(k.id);
  byKey.sort((a, b) =>
    a.id === "" ? -1 : b.id === "" ? 1 : b.monthRequests - a.monthRequests,
  );

  const limits = resolveUsageLimits(ctx.env, settings.usageLimits);
  const envPinned: UsageOverview["envPinned"] = [];
  if (
    ctx.env.USAGE_LIMIT_MODE === "off" ||
    ctx.env.USAGE_LIMIT_MODE === "soft" ||
    ctx.env.USAGE_LIMIT_MODE === "hard"
  )
    envPinned.push("mode");
  if (ctx.env.USAGE_LIMIT_REQUESTS_MONTH) envPinned.push("maxRequestsPerMonth");
  if (ctx.env.USAGE_LIMIT_STORAGE_BYTES) envPinned.push("maxStorageBytes");
  if (ctx.env.USAGE_LIMIT_DB_ROWS) envPinned.push("maxDbRows");

  let monthRequests = 0;
  let monthErrors = 0;
  for (const v of byKeyMonth.values()) {
    monthRequests += v.requests;
    monthErrors += v.errors;
  }

  const over: UsageOverview["over"] = [];
  if (limits.mode !== "off") {
    if (limits.maxRequestsPerMonth != null && monthRequests >= limits.maxRequestsPerMonth)
      over.push("requests");
    if (
      limits.maxStorageBytes != null &&
      gauges.storageBytes != null &&
      gauges.storageBytes >= limits.maxStorageBytes
    )
      over.push("storage");
    if (
      limits.maxDbRows != null &&
      gauges.dbRows != null &&
      gauges.dbRows >= limits.maxDbRows
    )
      over.push("rows");
  }

  return {
    month: utcMonth(),
    days,
    series,
    monthTotals: { requests: monthRequests, errors: monthErrors },
    byKey,
    gauges,
    limits,
    settingsLimits: settings.usageLimits,
    envPinned,
    over,
  };
};

/* ── Hard-cap enforcement helpers (storage / rows) ─────────────────────── */

/**
 * Throw QUOTA_EXCEEDED when a hard storage cap is set and `incomingBytes`
 * would push the workspace's stored file bytes over it. The current total is
 * summed live (indexed on `files.tenant_id`) — uploads are far rarer than
 * reads, so this doesn't need the gauge's staleness.
 */
export const assertStorageWithinLimit = async (
  ctx: UsageDbCtx,
  env: Env,
  tenantId: string,
  incomingBytes: number,
): Promise<void> => {
  const limits = await effectiveUsageLimits(ctx, env, tenantId);
  if (limits.mode !== "hard" || limits.maxStorageBytes == null) return;
  const filesT = ctx.dialect === "pg" ? pg.schema.files : sqlite.schema.files;
  const rows = (await (ctx.db as any)
    .select({ s: sql<number>`COALESCE(SUM(${filesT.size}), 0)` })
    .from(filesT)
    .where(eq(filesT.tenantId, tenantId))) as { s: number | string }[];
  const current = Number(rows[0]?.s ?? 0);
  if (current + Math.max(0, incomingBytes) > limits.maxStorageBytes) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      "Workspace storage limit reached — delete files or raise the limit",
      { scope: "storage", limit: limits.maxStorageBytes, used: current },
    );
  }
};

// Row-cap checks ride the sweep gauge (refreshed half-hourly) plus a short
// cache — a hard row cap is a resource ceiling, not an exact turnstile, and
// item creates are hot enough that a live COUNT across every collection per
// insert would be absurd. Documented as approximate.
const ROWS_CACHE_TTL_MS = 60_000;
const rowsGaugeCache = new Map<string, { value: number | null; at: number }>();

export const assertRowsWithinLimit = async (
  ctx: UsageDbCtx,
  env: Env,
  tenantId: string,
): Promise<void> => {
  const limits = await effectiveUsageLimits(ctx, env, tenantId);
  if (limits.mode !== "hard" || limits.maxDbRows == null) return;
  const hit = rowsGaugeCache.get(tenantId);
  let gauge: number | null;
  if (hit && Date.now() - hit.at < ROWS_CACHE_TTL_MS) {
    gauge = hit.value;
  } else {
    gauge = (await latestGauges(ctx, tenantId)).dbRows;
    if (rowsGaugeCache.size >= LIMITS_CACHE_CAP) rowsGaugeCache.clear();
    rowsGaugeCache.set(tenantId, { value: gauge, at: Date.now() });
  }
  if (gauge != null && gauge >= limits.maxDbRows) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      "Workspace row limit reached — delete rows or raise the limit",
      { scope: "rows", limit: limits.maxDbRows, used: gauge },
    );
  }
};

/* ── Gauge sweep (cron) ────────────────────────────────────────────────── */

const queryAll = async <T>(
  ctx: UsageDbCtx,
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

const esc = (v: string): string => v.replace(/'/g, "''");

/**
 * Measure every workspace's storage bytes (SUM over `files.size`) and total
 * collection rows (COUNT per physical table) and upsert them as gauges onto
 * today's `api_key_id=''` ledger row. Called from the cron tick, throttled
 * there — per-tenant COUNT(*)s are not per-minute work. Failures on one
 * workspace don't stop the sweep.
 */
export const sweepUsageGauges = async (
  ctx: UsageDbCtx,
  now: Date = new Date(),
): Promise<void> => {
  const tenantsT = ctx.dialect === "pg" ? pg.schema.tenants : sqlite.schema.tenants;
  const tenantRows = (await (ctx.db as any)
    .select({ id: tenantsT.id })
    .from(tenantsT)) as { id: string }[];
  const t = tableFor(ctx.dialect);
  const day = utcDay(now);
  for (const { id: tenantId } of tenantRows) {
    try {
      const sizeRows = await queryAll<{ s: number | string | null }>(
        ctx,
        sql.raw(
          `SELECT COALESCE(SUM(size), 0) AS s FROM files WHERE tenant_id = '${esc(tenantId)}'`,
        ),
      );
      const storageBytes = Number(sizeRows[0]?.s ?? 0);

      let dbRows = 0;
      const colls = await queryAll<{ physical_table: string }>(
        ctx,
        sql.raw(
          `SELECT physical_table FROM collections WHERE tenant_id = '${esc(tenantId)}'`,
        ),
      );
      const counts = await Promise.all(
        colls.map(async (cRow) => {
          const safeTable = (cRow.physical_table ?? "").replace(/"/g, "");
          if (!safeTable) return 0;
          try {
            const r = await queryAll<{ n: number | string }>(
              ctx,
              sql.raw(`SELECT COUNT(*) AS n FROM "${safeTable}"`),
            );
            return Number(r[0]?.n ?? 0);
          } catch {
            return 0; // physical table missing (metadata drift) — skip
          }
        }),
      );
      for (const n of counts) dbRows += n;

      await (ctx.db as any)
        .insert(t)
        .values({
          tenantId,
          apiKeyId: "",
          day,
          requests: 0,
          errors: 0,
          storageBytes,
          dbRows,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [t.tenantId, t.apiKeyId, t.day],
          set: { storageBytes, dbRows, updatedAt: now },
        });
    } catch (e) {
      console.error(`[usage-gauges] sweep failed for tenant ${tenantId}`, e);
    }
  }
};
