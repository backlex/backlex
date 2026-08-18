/**
 * Product analytics + crash reporting (#22).
 *
 * Two streams land here, both written by the public ingest endpoint and both
 * disposable (no FKs, pruned by retention):
 *
 * - **`analytics_events`** — tracked product events. Every "unique user" count
 *   and every funnel/retention cohort is keyed by `distinct_id` (a
 *   client-generated visitor id), not `user_id`, so anonymous pre-signup
 *   traffic is measurable and a visitor who later logs in still counts once.
 * - **`error_groups` / `error_events`** — crash reports. Occurrences fold into
 *   a group by fingerprint so a crash that fires 10k times is one row to
 *   triage. The group carries a denormalized `events` counter, so the list
 *   stays correct after the individual occurrences age out.
 *
 * **Why the analysis queries are raw SQL.** Funnels and retention are
 * self-joins over the event stream; expressing them as N round-trips would
 * either explode (an `IN` list of every cohort member) or pull the raw stream
 * into JS. They're written as parameterized CTE chains that both dialects
 * accept. The only dialect branch is timestamp shape — Postgres binds `Date`
 * against `timestamptz` and adds windows as an `interval`, SQLite binds epoch
 * milliseconds and adds them as integers ({@link tsParam}, {@link windowSql}).
 *
 * **Why `analytics_events.day` exists.** Cohort grouping runs on the
 * denormalized `YYYY-MM-DD` text column instead of date functions, which have
 * no portable spelling across Postgres/SQLite/D1. Same trick as
 * `usage_counters.day`.
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { hashToken } from "./shared-links";

export interface AnalyticsDbCtx {
  db: unknown;
  dialect: "pg" | "sqlite";
}

const eventsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.analyticsEvents : sqlite.schema.analyticsEvents;
const groupsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.errorGroups : sqlite.schema.errorGroups;
const occurrencesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.errorEvents : sqlite.schema.errorEvents;
const settingsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

/** UTC calendar day, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** UTC hour, `YYYY-MM-DDTHH`. Materialized for the same reason as {@link utcDay}:
 *  no hour-bucketing expression has a common spelling across Postgres, SQLite
 *  and D1, so the bucket is computed here rather than in SQL. Sorts lexically,
 *  and `slice(0, 10)` recovers the day from it. */
export const utcHour = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

/** Shift a `YYYY-MM-DD` day by N days. */
export const addDays = (day: string, n: number): string =>
  utcDay(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000);

/** Whole days between two `YYYY-MM-DD` days (`b - a`). */
export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Bind an epoch-ms instant against a timestamp column of either dialect. */
const tsParam = (dialect: "pg" | "sqlite", ms: number): Date | number =>
  dialect === "pg" ? new Date(ms) : ms;

/** Read an epoch-ms instant back out of either dialect's row shape. */
const tsValue = (v: unknown): number =>
  v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v ?? 0);

/**
 * `<base> + <ms>` as a SQL expression. The millisecond count is inlined as a
 * literal rather than bound — Postgres can't infer a parameter's type inside
 * an `interval` multiplication, and the value is a server-clamped integer
 * (never caller text), so there is nothing to inject.
 */
const windowSql = (dialect: "pg" | "sqlite", base: string, ms: number) =>
  dialect === "pg"
    ? sql.raw(`${base} + interval '${Math.floor(ms)} milliseconds'`)
    : sql.raw(`${base} + ${Math.floor(ms)}`);

/** Run a raw query against either dialect, normalising to a plain row array
 *  (mirrors `services/advisor.ts::runRaw`). */
const runRaw = async <T>(
  db: any,
  dialect: "pg" | "sqlite",
  query: ReturnType<typeof sql>,
): Promise<T[]> => {
  if (dialect === "pg") {
    const r = (await db.execute(query)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return (r as { rows: T[] }).rows;
    return r as T[];
  }
  return (await db.all(query)) as T[];
};

/** `tenant_id` predicate for raw SQL. NULL and a concrete id need different
 *  spellings; `IS NOT DISTINCT FROM` isn't portable to SQLite. */
const tenantSql = (tenantId: string | null, alias = "") => {
  const col = sql.raw(`${alias ? `${alias}.` : ""}tenant_id`);
  return tenantId === null ? sql`${col} IS NULL` : sql`${col} = ${tenantId}`;
};

/** Drizzle-builder twin of {@link tenantSql}. */
const tenantEq = (col: any, tenantId: string | null) =>
  tenantId === null ? isNull(col) : eq(col, tenantId);

/**
 * Restrict a report to visitor ids that outlive the day.
 *
 * Cohort retention and multi-day funnels both rest on "is this the same person
 * as yesterday", which a cookieless id cannot answer — it is regenerated at
 * UTC midnight by design. Including that traffic would not leave these reports
 * incomplete, it would make them WRONG in a way that still renders: every
 * returning visitor reads as new, so retention collapses toward 0% and no
 * funnel step on a later day ever converts. A wrong number that looks right is
 * worse than a missing one, so those two queries exclude rotating ids and the
 * UI says what share was excluded.
 *
 * Spelled `<> 'daily'` rather than `= 'durable'` on purpose: a NULL — a row
 * written before the column existed, or by some future writer that forgets to
 * set it — is then INCLUDED. Over-including a durable row is a far milder
 * failure than silently dropping real history.
 */
const durableOnly = (alias = "") => {
  const col = sql.raw(`${alias ? `${alias}.` : ""}id_scope`);
  return sql`(${col} IS NULL OR ${col} <> 'daily')`;
};

/* ── Ingest ───────────────────────────────────────────────────────────── */

/** Hard caps on one ingest batch — a hostile or buggy client can't turn a
 *  single request into an unbounded write. */
export const MAX_BATCH = 500;

/**
 * Bound-parameter budget per INSERT statement. D1 caps a statement at ~100
 * bound params, so a multi-row insert has to be split — a 500-event batch is
 * 7,500 params and fails outright with `too many SQL variables`. Postgres
 * allows far more, but one conservative constant keeps the chunking
 * dialect-free (same reasoning and value as `services/migrate-ingest.ts`).
 */
const PARAM_BUDGET = 90;

/** Insert rows in chunks that stay under {@link PARAM_BUDGET}. */
const insertChunked = async (
  ctx: AnalyticsDbCtx,
  table: unknown,
  rows: Record<string, unknown>[],
): Promise<void> => {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0] as Record<string, unknown>).length;
  const perStmt = Math.max(1, Math.floor(PARAM_BUDGET / Math.max(1, columns)));
  for (let i = 0; i < rows.length; i += perStmt) {
    await (ctx.db as any).insert(table).values(rows.slice(i, i + perStmt));
  }
};

/** Longest backdating accepted, so an offline queue can replay a week of
 *  events but a broken clock can't rewrite last year's numbers. */
const MAX_BACKDATE_MS = 7 * 86_400_000;
/** Small forward tolerance for clients whose clock runs slightly fast. */
const MAX_FUTURE_MS = 5 * 60_000;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

/** Clamp a client-supplied event time into the accepted window. */
const clampTs = (raw: unknown, now: number): number => {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : now;
  return Math.min(now + MAX_FUTURE_MS, Math.max(now - MAX_BACKDATE_MS, Math.floor(n)));
};

export interface TrackEventInput {
  name: string;
  distinctId: string;
  userId?: string | null;
  sessionId?: string | null;
  props?: Record<string, unknown> | null;
  path?: string | null;
  referrer?: string | null;
  source?: string | null;
  release?: string | null;
  country?: string | null;
  /** Registered site (`analytics_sites.id`) for web-stream rows; NULL for
   *  SDK / server traffic. Set by the collect route, never by a caller. */
  siteId?: string | null;
  /** `durable` (SDK localStorage id) or `daily` (server-derived cookieless
   *  hash). Defaults to `durable` — see the column's doc-comment for why the
   *  distinction is load-bearing for cohort reports. */
  idScope?: "durable" | "daily" | null;
  /** Derived server-side from the user-agent; not accepted from clients, which
   *  have no better information and every reason to be wrong. */
  deviceType?: string | null;
  browser?: string | null;
  os?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  /** Purchase amount in the currency's minor units. */
  revenue?: number | null;
  currency?: string | null;
  /** Epoch ms. Defaults to now; clamped to ±(7d, 5min). */
  ts?: number;
}

/**
 * Persist a batch of tracked events. Rows missing a `name` or `distinctId` are
 * dropped rather than failing the batch — a single malformed event must not
 * cost a mobile client its whole offline queue. The count of dropped rows is
 * returned so callers can surface it instead of silently under-reporting.
 */
export const recordEvents = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  input: TrackEventInput[],
  now = Date.now(),
): Promise<{ accepted: number; rejected: number }> => {
  if (input.length > MAX_BATCH) {
    throw new AppError("VALIDATION", `At most ${MAX_BATCH} events per request.`);
  }
  const rows = [];
  let rejected = 0;
  for (const e of input) {
    const name = str(e.name, 120);
    const distinctId = str(e.distinctId, 200);
    if (!name || !distinctId) {
      rejected++;
      continue;
    }
    const ms = clampTs(e.ts, now);
    rows.push({
      id: crypto.randomUUID(),
      tenantId,
      name,
      distinctId,
      userId: str(e.userId, 200),
      sessionId: str(e.sessionId, 200),
      props: e.props && typeof e.props === "object" ? e.props : null,
      path: str(e.path, 1000),
      referrer: str(e.referrer, 1000),
      source: str(e.source, 40),
      release: str(e.release, 80),
      country: str(e.country, 8),
      siteId: str(e.siteId, 64),
      idScope: e.idScope === "daily" ? "daily" : "durable",
      deviceType: str(e.deviceType, 16),
      browser: str(e.browser, 40),
      os: str(e.os, 40),
      utmSource: str(e.utmSource, 200),
      utmMedium: str(e.utmMedium, 200),
      utmCampaign: str(e.utmCampaign, 200),
      revenue: typeof e.revenue === "number" && Number.isFinite(e.revenue)
        ? Math.trunc(e.revenue)
        : null,
      currency: str(e.currency, 8)?.toUpperCase() ?? null,
      ts: new Date(ms),
      day: utcDay(ms),
      hour: utcHour(ms),
      createdAt: new Date(now),
    });
  }
  await insertChunked(ctx, eventsTable(ctx.dialect), rows);
  return { accepted: rows.length, rejected };
};

/* ── Error fingerprinting ─────────────────────────────────────────────── */

/**
 * Strip the parts of a message that vary per occurrence — ids, addresses,
 * URLs, numbers — so `Cannot read 'x' of user 4821` and the same failure for
 * user 913 land in one group instead of thousands.
 */
export const normalizeMessage = (message: string): string =>
  message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<addr>")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/\b\d[\d.,]*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

/**
 * Reduce a stack trace to its top frames with line/column numbers and cache-
 * busting query strings removed, so a rebuilt bundle doesn't fork the group.
 */
export const stackFrames = (stack: string | null | undefined, limit = 3): string[] => {
  if (!stack) return [];
  const out: string[] = [];
  for (const line of stack.split("\n")) {
    const t = line.trim();
    if (!t || !/^at\s|:\d+/.test(t)) continue;
    const frame = t
      .replace(/^at\s+/, "")
      .replace(/\?[^\s)]*/g, "")
      // Drop the trailing `:line:col`, keeping any wrapping paren so the frame
      // still reads as `doThing (/app/src/x.ts)`.
      .replace(/:\d+(:\d+)?(\))?\s*$/, "$2")
      .trim();
    if (frame) out.push(frame.slice(0, 200));
    if (out.length >= limit) break;
  }
  return out;
};

/** Stable identity of a bug: type + normalized message + top frames. */
export const fingerprintError = async (input: {
  type?: string | null;
  message: string;
  stack?: string | null;
}): Promise<string> => {
  const parts = [
    input.type ?? "Error",
    normalizeMessage(input.message),
    ...stackFrames(input.stack),
  ];
  return (await hashToken(parts.join("\n"))).slice(0, 40);
};

/** Deterministic group id, so ingest can upsert atomically on the primary key
 *  instead of racing a check-then-insert (see the schema comment). */
const groupIdFor = async (tenantId: string | null, fingerprint: string): Promise<string> =>
  (await hashToken(`${tenantId ?? ""}:${fingerprint}`)).slice(0, 32);

export interface TrackErrorInput {
  message: string;
  type?: string | null;
  stack?: string | null;
  level?: string | null;
  platform?: string | null;
  release?: string | null;
  url?: string | null;
  userId?: string | null;
  distinctId?: string | null;
  sessionId?: string | null;
  context?: Record<string, unknown> | null;
  ts?: number;
}

const LEVELS = new Set(["error", "warning", "fatal"]);

/**
 * Persist a batch of error occurrences and fold them into their groups.
 *
 * Occurrences that share a fingerprint inside one batch are aggregated before
 * the upsert, so a client replaying 200 copies of the same crash costs one
 * group write rather than 200 conflicting ones. A group that had been resolved
 * reopens on a new occurrence (a regression is news); one explicitly *ignored*
 * stays ignored — that's the whole point of ignoring it.
 */
export const recordErrors = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  input: TrackErrorInput[],
  now = Date.now(),
): Promise<{ accepted: number; rejected: number; groups: string[] }> => {
  if (input.length > MAX_BATCH) {
    throw new AppError("VALIDATION", `At most ${MAX_BATCH} errors per request.`);
  }
  interface Pending {
    groupId: string;
    fingerprint: string;
    type: string;
    message: string;
    culprit: string | null;
    level: string;
    platform: string | null;
    release: string | null;
    count: number;
    firstSeen: number;
    lastSeen: number;
  }
  const pending = new Map<string, Pending>();
  const occurrences = [];
  let rejected = 0;

  for (const e of input) {
    const message = str(e.message, 2000);
    if (!message) {
      rejected++;
      continue;
    }
    const type = str(e.type, 120) ?? "Error";
    const stack = str(e.stack, 20_000);
    const level = LEVELS.has(e.level ?? "") ? (e.level as string) : "error";
    const platform = str(e.platform, 40);
    const release = str(e.release, 80);
    const ms = clampTs(e.ts, now);
    const fingerprint = await fingerprintError({ type, message, stack });
    const groupId = await groupIdFor(tenantId, fingerprint);
    const culprit = stackFrames(stack, 1)[0] ?? null;

    const prev = pending.get(groupId);
    if (prev) {
      prev.count++;
      prev.firstSeen = Math.min(prev.firstSeen, ms);
      // The group's displayed message/culprit/release track the NEWEST
      // occurrence, so a batch that arrives out of order still ends up
      // describing the most recent sighting.
      if (ms >= prev.lastSeen) {
        prev.lastSeen = ms;
        prev.message = message;
        prev.culprit = culprit;
        prev.level = level;
        prev.platform = platform;
        prev.release = release;
      }
    } else {
      pending.set(groupId, {
        groupId,
        fingerprint,
        type,
        message,
        culprit,
        level,
        platform,
        release,
        count: 1,
        firstSeen: ms,
        lastSeen: ms,
      });
    }

    occurrences.push({
      id: crypto.randomUUID(),
      tenantId,
      groupId,
      type,
      message,
      stack,
      level,
      platform,
      release,
      url: str(e.url, 1000),
      userId: str(e.userId, 200),
      distinctId: str(e.distinctId, 200),
      sessionId: str(e.sessionId, 200),
      context: e.context && typeof e.context === "object" ? e.context : null,
      ts: new Date(ms),
      createdAt: new Date(now),
    });
  }

  const g = groupsTable(ctx.dialect);
  for (const p of pending.values()) {
    await (ctx.db as any)
      .insert(g)
      .values({
        id: p.groupId,
        tenantId,
        fingerprint: p.fingerprint,
        type: p.type,
        message: p.message,
        culprit: p.culprit,
        level: p.level,
        platform: p.platform,
        release: p.release,
        status: "open",
        events: p.count,
        firstSeen: new Date(p.firstSeen),
        lastSeen: new Date(p.lastSeen),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .onConflictDoUpdate({
        target: g.id,
        set: {
          events: sql`${g.events} + ${p.count}`,
          message: p.message,
          culprit: p.culprit,
          level: p.level,
          platform: p.platform,
          release: p.release,
          lastSeen: sql`CASE WHEN ${g.lastSeen} > excluded.last_seen THEN ${g.lastSeen} ELSE excluded.last_seen END`,
          firstSeen: sql`CASE WHEN ${g.firstSeen} < excluded.first_seen THEN ${g.firstSeen} ELSE excluded.first_seen END`,
          status: sql`CASE WHEN ${g.status} = 'ignored' THEN 'ignored' ELSE 'open' END`,
          resolvedAt: sql`CASE WHEN ${g.status} = 'ignored' THEN ${g.resolvedAt} ELSE NULL END`,
          updatedAt: new Date(now),
        },
      });
  }

  await insertChunked(ctx, occurrencesTable(ctx.dialect), occurrences);
  return {
    accepted: occurrences.length,
    rejected,
    groups: [...pending.keys()],
  };
};

/* ── Ingest key ───────────────────────────────────────────────────────── */

/** Publishable — it ships inside browser and mobile bundles, so it grants
 *  append-only ingest and nothing else. Prefixed so a leaked one is
 *  recognisable in logs and greppable in a codebase. */
export const INGEST_KEY_PREFIX = "alk";
const INGEST_SETTINGS_KEY = "analyticsIngestKeyHash";

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Deterministic `app_settings.id` for a workspace's ingest-key row.
 *
 * The natural key would be the `(tenant_id, key)` unique index, but SQLite and
 * D1 treat NULLs as DISTINCT there, so `ON CONFLICT (tenant_id, key)` silently
 * inserts a *second* row for the default workspace — which left a rotated key
 * still resolving alongside its replacement. Conflicting on the primary key
 * instead dedupes for null and non-null tenants alike, and stays atomic (no
 * check-then-insert race). Safe because this row is only ever written here.
 */
const ingestKeyRowId = (tenantId: string | null): string =>
  `${INGEST_SETTINGS_KEY}:${tenantId ?? ""}`;

/** Mint a fresh ingest key for a workspace, rotating any prior one. The
 *  plaintext is returned once; only its SHA-256 hash is stored. */
export const mintIngestKey = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
): Promise<{ key: string }> => {
  const key = `${INGEST_KEY_PREFIX}_${randomHex(24)}`;
  const hash = await hashToken(key);
  const t = settingsTable(ctx.dialect);
  await (ctx.db as any)
    .insert(t)
    .values({
      id: ingestKeyRowId(tenantId),
      tenantId,
      key: INGEST_SETTINGS_KEY,
      value: hash,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: t.id,
      set: { value: hash, updatedAt: new Date() },
    });
  return { key };
};

/** Revoke the workspace's ingest key (idempotent). */
export const revokeIngestKey = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
): Promise<void> => {
  const t = settingsTable(ctx.dialect);
  await (ctx.db as any)
    .delete(t)
    .where(and(tenantEq(t.tenantId, tenantId), eq(t.key, INGEST_SETTINGS_KEY)));
};

/** Whether the workspace currently has an ingest key (the plaintext is never
 *  recoverable — the admin UI shows presence, not the value). */
export const hasIngestKey = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
): Promise<boolean> => {
  const t = settingsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(tenantEq(t.tenantId, tenantId), eq(t.key, INGEST_SETTINGS_KEY)))
    .limit(1)) as unknown[];
  return rows.length > 0;
};

/**
 * Resolve a plaintext ingest key to its workspace. Returns `{ tenantId }` (the
 * id may legitimately be `null` — the default workspace) or `null` when the
 * key is unknown.
 *
 * The candidate rows are compared in JS rather than matched in SQL: `value` is
 * a JSON column whose equality spelling differs between `jsonb` and SQLite
 * text, and there is at most one row per workspace, so the scan is trivial.
 */
export const resolveIngestKey = async (
  ctx: AnalyticsDbCtx,
  key: string,
): Promise<{ tenantId: string | null } | null> => {
  if (!key || !key.startsWith(`${INGEST_KEY_PREFIX}_`)) return null;
  const hash = await hashToken(key);
  const t = settingsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ tenantId: t.tenantId, value: t.value })
    .from(t)
    .where(eq(t.key, INGEST_SETTINGS_KEY))) as {
    tenantId: string | null;
    value: unknown;
  }[];
  const hit = rows.find((r) => r.value === hash);
  return hit ? { tenantId: hit.tenantId ?? null } : null;
};

/* ── Overview ─────────────────────────────────────────────────────────── */

export interface AnalyticsRange {
  tenantId: string | null;
  /** Inclusive epoch-ms bounds. */
  from: number;
  to: number;
}

/** One row of a top-N breakdown. `users` is distinct visitors, which is what a
 *  website-analytics report leads with — `count` alone answers "how many hits"
 *  when the question is almost always "how many people". */
export interface AnalyticsBreakdownRow {
  value: string;
  count: number;
  users: number;
}

export interface AnalyticsOverview {
  totals: {
    events: number;
    /**
     * Distinct visitor ids in range.
     *
     * Read this together with `cookielessShare`. Cookieless ids rotate at UTC
     * midnight, so for that share of traffic one returning person contributes
     * one id PER DAY and this figure is inflated. `durableUsers` and
     * `visitorsPerDay` are the two figures that are always true; this one is
     * kept because it is what every existing caller already reads.
     */
    users: number;
    sessions: number;
    /** Unique visitors among durable (SDK localStorage) ids only. Correct over
     *  any range length, because those ids do not rotate. */
    durableUsers: number;
    /** Mean distinct cookieless visitors per active day. The strongest true
     *  statement available for rotating ids — they cannot be de-duplicated
     *  across a day boundary. NULL when there is no cookieless traffic. */
    visitorsPerDay: number | null;
    /** Fraction of events in range carrying a rotating id, 0..1. Zero until
     *  the web tag ships; the UI switches its visitor label on it. */
    cookielessShare: number;
  };
  /** One point per UTC day in range, zero-filled so charts don't gap. */
  series: { day: string; events: number; users: number }[];
  topEvents: { name: string; count: number; users: number }[];
  /** These three keep their historical key name (`path` / `referrer` /
   *  `source`) rather than the generic `value`, because SDK and GraphQL
   *  consumers already read them by that name. They gain `users` like every
   *  other breakdown. */
  topPaths: { path: string; count: number; users: number }[];
  topReferrers: { referrer: string; count: number; users: number }[];
  sources: { source: string; count: number; users: number }[];
  /** Website dimensions, derived server-side at ingest. */
  topCountries: AnalyticsBreakdownRow[];
  topDevices: AnalyticsBreakdownRow[];
  topCampaigns: AnalyticsBreakdownRow[];
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Columns a top-N breakdown may group by.
 *
 * Deliberately a closed union rather than a free string: this value reaches a
 * `groupBy` and the set of things it is safe to group by is exactly "a real
 * column on this table". Widening it to `string` would turn a report parameter
 * into an injection surface for no gain — a caller wanting to break down by an
 * arbitrary `props` key needs the JSON-extract path, which is a different
 * query with its own `json_valid` guard.
 */
export type BreakdownColumn =
  | "path"
  | "referrer"
  | "source"
  | "country"
  | "deviceType"
  | "browser"
  | "os"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign";

/** Top-N breakdown over one column, skipping NULL/empty values. */
const topBy = async (
  ctx: AnalyticsDbCtx,
  range: AnalyticsRange,
  column: BreakdownColumn,
  limit: number,
): Promise<AnalyticsBreakdownRow[]> => {
  const t = eventsTable(ctx.dialect);
  const col = (t as any)[column];
  const rows = (await (ctx.db as any)
    .select({
      value: col,
      count: sql<number>`count(*)`,
      users: sql<number>`count(distinct ${t.distinctId})`,
    })
    .from(t)
    .where(
      and(
        tenantEq(t.tenantId, range.tenantId),
        gte(t.ts, tsParam(ctx.dialect, range.from) as any),
        lte(t.ts, tsParam(ctx.dialect, range.to) as any),
        sql`${col} IS NOT NULL AND ${col} <> ''`,
      ),
    )
    .groupBy(col)
    .orderBy(desc(sql`count(*)`))
    .limit(limit)) as { value: string; count: unknown; users: unknown }[];
  return rows.map((r) => ({
    value: r.value,
    count: num(r.count),
    users: num(r.users),
  }));
};

/** Headline counters, the daily series and the top-N breakdowns. */
export const analyticsOverview = async (
  ctx: AnalyticsDbCtx,
  range: AnalyticsRange,
): Promise<AnalyticsOverview> => {
  const t = eventsTable(ctx.dialect);
  const inRange = and(
    tenantEq(t.tenantId, range.tenantId),
    gte(t.ts, tsParam(ctx.dialect, range.from) as any),
    lte(t.ts, tsParam(ctx.dialect, range.to) as any),
  );

  // `count(distinct case when ... end)` and `sum(case when ... end)` are both
  // plain SQL-92 and need no dialect branch, which is why the two
  // cookieless-aware figures ride along on the existing round-trip instead of
  // costing two more queries.
  const [totalsRow] = (await (ctx.db as any)
    .select({
      events: sql<number>`count(*)`,
      users: sql<number>`count(distinct ${t.distinctId})`,
      sessions: sql<number>`count(distinct ${t.sessionId})`,
      durableUsers: sql<number>`count(distinct case when ${t.idScope} <> 'daily' then ${t.distinctId} end)`,
      cookielessEvents: sql<number>`sum(case when ${t.idScope} = 'daily' then 1 else 0 end)`,
    })
    .from(t)
    .where(inRange)) as {
    events: unknown;
    users: unknown;
    sessions: unknown;
    durableUsers: unknown;
    cookielessEvents: unknown;
  }[];

  const seriesRows = (await (ctx.db as any)
    .select({
      day: t.day,
      events: sql<number>`count(*)`,
      users: sql<number>`count(distinct ${t.distinctId})`,
      cookielessUsers: sql<number>`count(distinct case when ${t.idScope} = 'daily' then ${t.distinctId} end)`,
    })
    .from(t)
    .where(inRange)
    .groupBy(t.day)
    .orderBy(t.day)) as {
    day: string;
    events: unknown;
    users: unknown;
    cookielessUsers: unknown;
  }[];

  const eventRows = (await (ctx.db as any)
    .select({
      name: t.name,
      count: sql<number>`count(*)`,
      users: sql<number>`count(distinct ${t.distinctId})`,
    })
    .from(t)
    .where(inRange)
    .groupBy(t.name)
    .orderBy(desc(sql`count(*)`))
    .limit(10)) as { name: string; count: unknown; users: unknown }[];

  const [paths, referrers, sources, countries, devices, campaigns] =
    await Promise.all([
      topBy(ctx, range, "path", 10),
      topBy(ctx, range, "referrer", 10),
      topBy(ctx, range, "source", 6),
      topBy(ctx, range, "country", 10),
      // Four buckets exist (desktop/mobile/tablet/bot); 6 leaves headroom
      // without implying there is a long tail.
      topBy(ctx, range, "deviceType", 6),
      topBy(ctx, range, "utmSource", 10),
    ]);

  // Zero-fill so a quiet day renders as a gap-free zero rather than a jump.
  const byDay = new Map(seriesRows.map((r) => [r.day, r]));
  const series: AnalyticsOverview["series"] = [];
  const firstDay = utcDay(range.from);
  const lastDay = utcDay(range.to);
  for (let d = firstDay; daysBetween(d, lastDay) >= 0; d = addDays(d, 1)) {
    const hit = byDay.get(d);
    series.push({ day: d, events: num(hit?.events), users: num(hit?.users) });
    if (series.length > 400) break; // guardrail on an absurd range
  }

  // A rotating id cannot be de-duplicated across days, so the honest figure for
  // that traffic is a per-active-day mean rather than a range-wide distinct.
  // Averaged over days that actually saw cookieless traffic — including quiet
  // days would report a drop in visitors that is really a drop in days.
  const cookielessDays = seriesRows
    .map((r) => num(r.cookielessUsers))
    .filter((n) => n > 0);
  const visitorsPerDay = cookielessDays.length
    ? Math.round(
        cookielessDays.reduce((a, b) => a + b, 0) / cookielessDays.length,
      )
    : null;

  const events = num(totalsRow?.events);
  const cookielessEvents = num(totalsRow?.cookielessEvents);

  return {
    totals: {
      events,
      users: num(totalsRow?.users),
      sessions: num(totalsRow?.sessions),
      durableUsers: num(totalsRow?.durableUsers),
      visitorsPerDay,
      cookielessShare: events > 0 ? cookielessEvents / events : 0,
    },
    series,
    topEvents: eventRows.map((r) => ({
      name: r.name,
      count: num(r.count),
      users: num(r.users),
    })),
    topPaths: paths.map((r) => ({ path: r.value, count: r.count, users: r.users })),
    topReferrers: referrers.map((r) => ({
      referrer: r.value,
      count: r.count,
      users: r.users,
    })),
    sources: sources.map((r) => ({
      source: r.value,
      count: r.count,
      users: r.users,
    })),
    topCountries: countries,
    topDevices: devices,
    topCampaigns: campaigns,
  };
};

/** Distinct event names seen recently — powers the funnel builder's dropdown
 *  so steps are picked, not typed. */
export const listEventNames = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  limit = 100,
): Promise<string[]> => {
  const t = eventsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ name: t.name })
    .from(t)
    .where(tenantEq(t.tenantId, tenantId))
    .groupBy(t.name)
    .orderBy(desc(sql`count(*)`))
    .limit(limit)) as { name: string }[];
  return rows.map((r) => r.name);
};

/* ── Funnel ───────────────────────────────────────────────────────────── */

export interface FunnelStepResult {
  name: string;
  /** Distinct users who completed this step in order, within the window. */
  count: number;
  /** Share of step 1's cohort that reached here (`1` for step 1). */
  conversion: number;
  /** Share of the *previous* step's cohort lost here (`0` for step 1). */
  dropOff: number;
}

export const MAX_FUNNEL_STEPS = 8;

/**
 * Ordered conversion funnel. A user counts at step N only if they fired step N
 * strictly after their first step N-1, within `windowDays` of **their own**
 * step-1 time — the standard "converted within X days of entering" definition,
 * not a fixed calendar window.
 *
 * Built as a CTE chain (one CTE per step, each joined to the previous on
 * `distinct_id`) so the whole funnel is a single round-trip regardless of
 * cohort size.
 */
export const analyticsFunnel = async (
  ctx: AnalyticsDbCtx,
  opts: AnalyticsRange & { steps: string[]; windowDays?: number },
): Promise<{ steps: FunnelStepResult[]; windowDays: number }> => {
  const steps = opts.steps.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (steps.length < 2) {
    throw new AppError("VALIDATION", "A funnel needs at least 2 steps.");
  }
  if (steps.length > MAX_FUNNEL_STEPS) {
    throw new AppError("VALIDATION", `At most ${MAX_FUNNEL_STEPS} funnel steps.`);
  }
  const windowDays = Math.min(365, Math.max(1, Math.floor(opts.windowDays ?? 7)));
  const windowMs = windowDays * 86_400_000;
  const from = tsParam(ctx.dialect, opts.from);
  const to = tsParam(ctx.dialect, opts.to);

  const ctes = [
    sql`s0 AS (SELECT distinct_id, MIN(ts) AS t FROM analytics_events
        WHERE ${tenantSql(opts.tenantId)} AND name = ${steps[0]}
          AND ts >= ${from} AND ts <= ${to} AND ${durableOnly()}
        GROUP BY distinct_id)`,
  ];
  for (let i = 1; i < steps.length; i++) {
    const prev = sql.raw(`s${i - 1}`);
    const cur = sql.raw(`s${i}`);
    // The window is measured from the user's step-1 time, so s0 has to be in
    // scope. For i === 1 the previous CTE *is* s0; past that it must be joined
    // explicitly or `s0.t` would reference an unknown relation.
    const entryJoin =
      i === 1 ? sql`` : sql` JOIN s0 ON s0.distinct_id = e.distinct_id`;
    ctes.push(
      sql`${cur} AS (SELECT e.distinct_id, MIN(e.ts) AS t
          FROM analytics_events e JOIN ${prev} ON ${prev}.distinct_id = e.distinct_id${entryJoin}
          WHERE ${tenantSql(opts.tenantId, "e")} AND e.name = ${steps[i]}
            AND ${durableOnly("e")}
            AND e.ts > ${prev}.t AND e.ts <= ${to}
            AND e.ts <= ${windowSql(ctx.dialect, "s0.t", windowMs)}
          GROUP BY e.distinct_id)`,
    );
  }
  const selects = steps.map(
    (_, i) => sql`(SELECT COUNT(*) FROM ${sql.raw(`s${i}`)}) AS ${sql.raw(`c${i}`)}`,
  );
  const query = sql`WITH ${sql.join(ctes, sql`, `)} SELECT ${sql.join(selects, sql`, `)}`;

  const rows = await runRaw<Record<string, unknown>>(ctx.db, ctx.dialect, query);
  const row = rows[0] ?? {};
  const counts = steps.map((_, i) => num(row[`c${i}`]));
  const entry = counts[0] ?? 0;

  return {
    windowDays,
    steps: steps.map((name, i) => {
      const count = counts[i] ?? 0;
      const prev = i === 0 ? count : (counts[i - 1] ?? 0);
      return {
        name,
        count,
        conversion: entry > 0 ? count / entry : 0,
        dropOff: i === 0 || prev === 0 ? 0 : (prev - count) / prev,
      };
    }),
  };
};

/* ── Retention ────────────────────────────────────────────────────────── */

export interface RetentionCohort {
  /** `YYYY-MM-DD` day the cohort's users were first ever seen. */
  day: string;
  size: number;
  /** `values[n]` = users of this cohort active n days later (`values[0]` = size). */
  values: number[];
}

/**
 * Cohort retention. A cohort is every visitor whose **first-ever** event day
 * falls in the range — computed with a `HAVING MIN(day)` over the full history
 * rather than the range alone, so a long-standing user who happened to return
 * this week isn't miscounted as new.
 *
 * The join produces at most `days × days` rows, so day-offset arithmetic is
 * finished in JS on the `YYYY-MM-DD` strings — no portable date math needed.
 */
export const analyticsRetention = async (
  ctx: AnalyticsDbCtx,
  opts: AnalyticsRange & { event?: string | null },
): Promise<{ cohorts: RetentionCohort[]; maxOffset: number }> => {
  const fromDay = utcDay(opts.from);
  const toDay = utcDay(opts.to);
  const span = Math.max(0, daysBetween(fromDay, toDay));
  const maxOffset = Math.min(span, 30);
  const nameFilter = opts.event ? sql` AND name = ${opts.event}` : sql``;

  const query = sql`
    WITH f AS (
      SELECT distinct_id, MIN(day) AS d0 FROM analytics_events
      WHERE ${tenantSql(opts.tenantId)}${nameFilter} AND ${durableOnly()}
      GROUP BY distinct_id
      HAVING MIN(day) >= ${fromDay} AND MIN(day) <= ${toDay}
    ),
    a AS (
      SELECT DISTINCT distinct_id, day FROM analytics_events
      WHERE ${tenantSql(opts.tenantId)}${nameFilter} AND ${durableOnly()}
        AND day >= ${fromDay} AND day <= ${toDay}
    )
    SELECT f.d0 AS cohort, a.day AS day, COUNT(DISTINCT a.distinct_id) AS n
    FROM f JOIN a ON a.distinct_id = f.distinct_id
    GROUP BY f.d0, a.day`;

  const rows = await runRaw<{ cohort: string; day: string; n: unknown }>(
    ctx.db,
    ctx.dialect,
    query,
  );

  const byCohort = new Map<string, number[]>();
  for (const r of rows) {
    const offset = daysBetween(r.cohort, r.day);
    if (offset < 0 || offset > maxOffset) continue;
    let values = byCohort.get(r.cohort);
    if (!values) {
      values = new Array(maxOffset + 1).fill(0);
      byCohort.set(r.cohort, values);
    }
    values[offset] = num(r.n);
  }

  const cohorts: RetentionCohort[] = [];
  for (let d = fromDay; daysBetween(d, toDay) >= 0; d = addDays(d, 1)) {
    const values = byCohort.get(d);
    if (!values) continue;
    cohorts.push({ day: d, size: values[0] ?? 0, values });
    if (cohorts.length > 120) break;
  }
  return { cohorts, maxOffset };
};

/* ── Raw event stream ─────────────────────────────────────────────────── */

export interface AnalyticsEventRow {
  id: string;
  name: string;
  distinctId: string;
  userId: string | null;
  sessionId: string | null;
  props: Record<string, unknown> | null;
  path: string | null;
  referrer: string | null;
  source: string | null;
  release: string | null;
  country: string | null;
  /** Server-derived web dimensions. Present on the raw-event view because this
   *  is the debug surface — when a breakdown looks wrong, the first question is
   *  what actually landed on the row. */
  siteId: string | null;
  idScope: string | null;
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  revenue: number | null;
  currency: string | null;
  ts: number;
}

/** Recent raw events — the debug view behind the aggregates. */
export const listAnalyticsEvents = async (
  ctx: AnalyticsDbCtx,
  opts: {
    tenantId: string | null;
    limit: number;
    from?: number;
    to?: number;
    name?: string | null;
    distinctId?: string | null;
  },
): Promise<AnalyticsEventRow[]> => {
  const t = eventsTable(ctx.dialect);
  const clauses = [tenantEq(t.tenantId, opts.tenantId)];
  if (opts.from !== undefined) clauses.push(gte(t.ts, tsParam(ctx.dialect, opts.from) as any));
  if (opts.to !== undefined) clauses.push(lte(t.ts, tsParam(ctx.dialect, opts.to) as any));
  if (opts.name) clauses.push(eq(t.name, opts.name));
  if (opts.distinctId) clauses.push(eq(t.distinctId, opts.distinctId));

  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(...clauses))
    .orderBy(desc(t.ts))
    .limit(Math.min(500, Math.max(1, opts.limit)))) as any[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    distinctId: r.distinctId,
    userId: r.userId ?? null,
    sessionId: r.sessionId ?? null,
    props: (r.props as Record<string, unknown> | null) ?? null,
    path: r.path ?? null,
    referrer: r.referrer ?? null,
    source: r.source ?? null,
    release: r.release ?? null,
    country: r.country ?? null,
    siteId: r.siteId ?? null,
    idScope: r.idScope ?? null,
    deviceType: r.deviceType ?? null,
    browser: r.browser ?? null,
    os: r.os ?? null,
    utmSource: r.utmSource ?? null,
    utmMedium: r.utmMedium ?? null,
    utmCampaign: r.utmCampaign ?? null,
    revenue: r.revenue == null ? null : Number(r.revenue),
    currency: r.currency ?? null,
    ts: tsValue(r.ts),
  }));
};

/* ── Error groups ─────────────────────────────────────────────────────── */

export interface ErrorGroupRow {
  id: string;
  fingerprint: string;
  type: string;
  message: string;
  culprit: string | null;
  level: string;
  platform: string | null;
  release: string | null;
  status: string;
  events: number;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

const toGroupRow = (r: any): ErrorGroupRow => ({
  id: r.id,
  fingerprint: r.fingerprint,
  type: r.type,
  message: r.message,
  culprit: r.culprit ?? null,
  level: r.level,
  platform: r.platform ?? null,
  release: r.release ?? null,
  status: r.status,
  events: num(r.events),
  firstSeen: tsValue(r.firstSeen),
  lastSeen: tsValue(r.lastSeen),
  resolvedAt: r.resolvedAt == null ? null : tsValue(r.resolvedAt),
  resolvedBy: r.resolvedBy ?? null,
});

export const ERROR_STATUSES = ["open", "resolved", "ignored"] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

export const listErrorGroups = async (
  ctx: AnalyticsDbCtx,
  opts: {
    tenantId: string | null;
    limit: number;
    status?: string | null;
    level?: string | null;
    /** Only groups seen at/after this epoch-ms. */
    since?: number;
  },
): Promise<ErrorGroupRow[]> => {
  const t = groupsTable(ctx.dialect);
  const clauses = [tenantEq(t.tenantId, opts.tenantId)];
  if (opts.status) clauses.push(eq(t.status, opts.status));
  if (opts.level) clauses.push(eq(t.level, opts.level));
  if (opts.since !== undefined) {
    clauses.push(gte(t.lastSeen, tsParam(ctx.dialect, opts.since) as any));
  }
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(...clauses))
    .orderBy(desc(t.lastSeen))
    .limit(Math.min(200, Math.max(1, opts.limit)))) as any[];
  return rows.map(toGroupRow);
};

export interface ErrorOccurrenceRow {
  id: string;
  message: string;
  stack: string | null;
  level: string;
  platform: string | null;
  release: string | null;
  url: string | null;
  userId: string | null;
  distinctId: string | null;
  sessionId: string | null;
  context: Record<string, unknown> | null;
  ts: number;
}

export interface ErrorGroupDetail {
  group: ErrorGroupRow;
  /** Most recent captured occurrences (stack + context). */
  occurrences: ErrorOccurrenceRow[];
  /** Occurrences per UTC day, from the retained sample rows. */
  series: { day: string; count: number }[];
  /** Distinct visitors affected, over the retained sample rows. */
  users: number;
}

export const getErrorGroup = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  id: string,
  sampleLimit = 20,
): Promise<ErrorGroupDetail> => {
  const g = groupsTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select()
    .from(g)
    .where(and(tenantEq(g.tenantId, tenantId), eq(g.id, id)))
    .limit(1)) as any[];
  if (!row) throw new AppError("NOT_FOUND", "Error group not found.");

  const e = occurrencesTable(ctx.dialect);
  const occRows = (await (ctx.db as any)
    .select()
    .from(e)
    .where(eq(e.groupId, id))
    .orderBy(desc(e.ts))
    .limit(Math.min(100, Math.max(1, sampleLimit)))) as any[];

  // `error_events.ts` has no denormalized day column (unlike analytics_events —
  // errors never drive cohort math), so the daily rollup is folded in JS over
  // the retained rows.
  const dayCounts = new Map<string, number>();
  const allRows = (await (ctx.db as any)
    .select({ ts: e.ts, distinctId: e.distinctId })
    .from(e)
    .where(eq(e.groupId, id))
    .orderBy(desc(e.ts))
    .limit(5000)) as { ts: unknown; distinctId: string | null }[];
  const users = new Set<string>();
  for (const r of allRows) {
    const day = utcDay(tsValue(r.ts));
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    if (r.distinctId) users.add(r.distinctId);
  }

  return {
    group: toGroupRow(row),
    occurrences: occRows.map((r) => ({
      id: r.id,
      message: r.message,
      stack: r.stack ?? null,
      level: r.level,
      platform: r.platform ?? null,
      release: r.release ?? null,
      url: r.url ?? null,
      userId: r.userId ?? null,
      distinctId: r.distinctId ?? null,
      sessionId: r.sessionId ?? null,
      context: (r.context as Record<string, unknown> | null) ?? null,
      ts: tsValue(r.ts),
    })),
    series: [...dayCounts.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    users: users.size,
  };
};

/** Triage a group: resolve / ignore / reopen. */
export const updateErrorGroup = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  id: string,
  patch: { status: string },
  actorId: string | null,
): Promise<ErrorGroupRow> => {
  if (!(ERROR_STATUSES as readonly string[]).includes(patch.status)) {
    throw new AppError(
      "VALIDATION",
      `status must be one of ${ERROR_STATUSES.join(", ")}.`,
    );
  }
  const g = groupsTable(ctx.dialect);
  const resolved = patch.status === "resolved";
  await (ctx.db as any)
    .update(g)
    .set({
      status: patch.status,
      resolvedAt: resolved ? new Date() : null,
      resolvedBy: resolved ? actorId : null,
      updatedAt: new Date(),
    })
    .where(and(tenantEq(g.tenantId, tenantId), eq(g.id, id)));

  const [row] = (await (ctx.db as any)
    .select()
    .from(g)
    .where(and(tenantEq(g.tenantId, tenantId), eq(g.id, id)))
    .limit(1)) as any[];
  if (!row) throw new AppError("NOT_FOUND", "Error group not found.");
  return toGroupRow(row);
};

/** Delete a group and its captured occurrences. */
export const deleteErrorGroup = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  id: string,
): Promise<void> => {
  const g = groupsTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select({ id: g.id })
    .from(g)
    .where(and(tenantEq(g.tenantId, tenantId), eq(g.id, id)))
    .limit(1)) as any[];
  if (!row) throw new AppError("NOT_FOUND", "Error group not found.");
  const e = occurrencesTable(ctx.dialect);
  await (ctx.db as any).delete(e).where(eq(e.groupId, id));
  await (ctx.db as any).delete(g).where(eq(g.id, id));
};

/* ── Retention pruning ────────────────────────────────────────────────── */

/** Drop tracked events older than `days`. Returns nothing — the sweep logs. */
export const pruneAnalyticsEvents = async (
  ctx: AnalyticsDbCtx,
  days: number,
): Promise<void> => {
  const cutoff = Date.now() - Math.max(1, days) * 86_400_000;
  const t = eventsTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(lte(t.ts, tsParam(ctx.dialect, cutoff) as any));
};

/**
 * Drop error occurrences older than `days`, then any group whose occurrences
 * are all gone *and* which hasn't been seen since the cutoff — so a long-quiet
 * bug disappears with its payloads while an active one keeps its full history
 * and counter.
 */
export const pruneErrorEvents = async (
  ctx: AnalyticsDbCtx,
  days: number,
): Promise<void> => {
  const cutoff = Date.now() - Math.max(1, days) * 86_400_000;
  const e = occurrencesTable(ctx.dialect);
  const g = groupsTable(ctx.dialect);
  await (ctx.db as any).delete(e).where(lte(e.ts, tsParam(ctx.dialect, cutoff) as any));

  const stale = (await (ctx.db as any)
    .select({ id: g.id })
    .from(g)
    .where(lte(g.lastSeen, tsParam(ctx.dialect, cutoff) as any))
    .limit(1000)) as { id: string }[];
  if (stale.length === 0) return;
  const ids = stale.map((r) => r.id);
  const survivors = (await (ctx.db as any)
    .select({ groupId: e.groupId })
    .from(e)
    .where(inArray(e.groupId, ids))
    .groupBy(e.groupId)) as { groupId: string }[];
  const keep = new Set(survivors.map((r) => r.groupId));
  const drop = ids.filter((id) => !keep.has(id));
  if (drop.length > 0) {
    await (ctx.db as any).delete(g).where(inArray(g.id, drop));
  }
};
