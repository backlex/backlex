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
 * milliseconds and adds them as integers ({@link tsParam}, {@link windowSql},
 * {@link elapsedMsSql} — all three are the same branch wearing different hats:
 * how an instant is bound, offset, and subtracted).
 *
 * **Why `analytics_events.day` exists.** Cohort grouping runs on the
 * denormalized `YYYY-MM-DD` text column instead of date functions, which have
 * no portable spelling across Postgres/SQLite/D1. Same trick as
 * `usage_counters.day`.
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import { classifyChannel, sourceMediumLabel } from "./analytics-channels";
import { parseUtm } from "./analytics-enrich";
import {
  compileSegment,
  compileSegmentRaw,
  parseSegment,
  type SegmentNode,
} from "./analytics-segments";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { hashToken } from "./shared-links";
import { deletePolicyForDeletedSite } from "./consent";
import { deleteSiteRecords } from "./consent-records";

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
const sitesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.analyticsSites : sqlite.schema.analyticsSites;
const segmentsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.analyticsSegments : sqlite.schema.analyticsSegments;

/** UTC calendar day, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** UTC hour, `YYYY-MM-DDTHH`. Materialized for the same reason as {@link utcDay}:
 *  no hour-bucketing expression has a common spelling across Postgres, SQLite
 *  and D1, so the bucket is computed here rather than in SQL. Sorts lexically,
 *  and `slice(0, 10)` recovers the day from it. */
export const utcHour = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

/**
 * A path with its query string removed — the key page reports group by.
 *
 * `path` keeps the query, because campaign tags live there and `?q=` /
 * `?page=2` are real information. Grouping on it, though, splits one page into
 * a row per campaign variant: `/pricing?utm_source=a` and `/pricing?utm_source=b`
 * report as two different pages. Materialized at write time for the same reason
 * `day` and `hour` are — no substring-before-a-character expression has a
 * common spelling across Postgres, SQLite and D1, and a stored column can be
 * indexed where an expression cannot.
 */
export const pathWithoutQuery = (path: string | null): string | null => {
  if (!path) return null;
  const q = path.indexOf("?");
  const base = q === -1 ? path : path.slice(0, q);
  return base || null;
};

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

/**
 * `<b> - <a>` as a millisecond count.
 *
 * The third face of the one dialect branch this module allows. Subtracting two
 * `timestamptz` values in Postgres yields an `interval`, which cannot be summed
 * into a number; SQLite stores epoch milliseconds, so subtraction is already
 * the answer. Both sides are column references chosen here, never caller text.
 */
const elapsedMsSql = (dialect: "pg" | "sqlite", a: string, b: string) =>
  dialect === "pg"
    ? sql.raw(`(EXTRACT(EPOCH FROM (${b} - ${a})) * 1000)`)
    : sql.raw(`(${b} - ${a})`);

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
      pathBase: pathWithoutQuery(str(e.path, 1000)),
      referrer: str(e.referrer, 1000),
      source: str(e.source, 40),
      release: str(e.release, 80),
      country: str(e.country, 8),
      siteId: str(e.siteId, 64),
      idScope: e.idScope === "daily" ? "daily" : "durable",
      deviceType: str(e.deviceType, 16),
      browser: str(e.browser, 40),
      os: str(e.os, 40),
      // Campaign tags come from the EVENT's own landing path, not from the
      // request, so they are derived here rather than per-surface. Doing it in
      // the REST route only meant a GraphQL-ingested event silently lost its
      // campaign — same data, different answer depending on how it arrived.
      // An explicitly supplied value still wins, for a caller relaying events
      // whose original URL we never saw.
      ...(() => {
        const derived = parseUtm(e.path);
        return {
          utmSource: str(e.utmSource, 200) ?? derived.utmSource,
          utmMedium: str(e.utmMedium, 200) ?? derived.utmMedium,
          utmCampaign: str(e.utmCampaign, 200) ?? derived.utmCampaign,
        };
      })(),
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

/* ── Sessions ─────────────────────────────────────────────────────────── */

/** GA's session definition: a gap this long ends the session. */
export const SESSION_GAP_MS = 30 * 60_000;

export interface AnalyticsSessions {
  sessions: number;
  pageviews: number;
  /** Sessions with exactly one pageview, as a share of all sessions (0..1). */
  bounceRate: number;
  /** Mean session duration in ms. Bounces contribute 0 — a single hit has no
   *  measurable length, and dropping them would flatter the average. */
  avgDurationMs: number;
  pagesPerSession: number;
  landingPages: AnalyticsBreakdownRow[];
  exitPages: AnalyticsBreakdownRow[];
}

/**
 * Sessionize the web stream at query time.
 *
 * There is no `sessions` table and no second write path: a window function
 * derives session boundaries from the events already stored. A 30-minute gap
 * between one visitor's consecutive hits opens a new session, which is GA's
 * definition and Plausible's.
 *
 * **Partitioned by `(distinct_id, day)`, filtered on `day`.** Two reasons, and
 * the second is the load-bearing one. Cookieless ids are day-scoped anyway, so
 * a cross-day partition would be meaningless for them. And the index that can
 * serve this is `(tenant_id, day, distinct_id, ts)` — filtering on `ts` instead
 * would put the range predicate outside the index prefix and scan the tenant's
 * entire history. That index shipped in phase 1 precisely for this query.
 *
 * **`site_id IS NOT NULL`** restricts it to tag traffic. Server-side SDK
 * events have no session at all, and letting them in would inflate every
 * figure here with things that are not visits.
 *
 * The explicit `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` on
 * the FIRST_VALUE/LAST_VALUE frame is not decoration: the DEFAULT frame ends at
 * the current row, so `LAST_VALUE` without it returns the current row's path
 * rather than the session's last — an exit-page report that is silently just
 * the landing page.
 */
/**
 * The sessionization CTE chain, shared by every session-scoped report.
 *
 * Ends with a `numbered` relation of one row per event carrying its session
 * ordinal `sn`, so a caller only has to say what it wants per session. Kept in
 * one place because the gap rule IS the definition of a session — two copies
 * would be two definitions the moment one is tuned.
 */
const sessionCteSql = (
  ctx: AnalyticsDbCtx,
  opts: AnalyticsRange & { siteId?: string | null },
) => {
  const fromDay = utcDay(opts.from);
  const toDay = utcDay(opts.to);
  const siteFilter = opts.siteId ? sql` AND site_id = ${opts.siteId}` : sql``;
  return sql`
    lagged AS (
      SELECT distinct_id, day, ts, COALESCE(path_base, path) AS path,
             referrer, utm_source, utm_medium,
             LAG(ts) OVER (PARTITION BY distinct_id, day ORDER BY ts) AS prev_ts
      FROM analytics_events
      WHERE ${tenantSql(opts.tenantId)}
        AND day >= ${fromDay} AND day <= ${toDay}
        AND site_id IS NOT NULL${siteFilter}${segmentSql(ctx, opts)}
    ),
    marked AS (
      SELECT distinct_id, day, ts, path, referrer, utm_source, utm_medium,
             CASE WHEN prev_ts IS NULL
                       OR ${windowSql(ctx.dialect, "prev_ts", SESSION_GAP_MS)} < ts
                  THEN 1 ELSE 0 END AS is_new
      FROM lagged
    ),
    numbered AS (
      SELECT distinct_id, day, ts, path, referrer, utm_source, utm_medium,
             SUM(is_new) OVER (
               PARTITION BY distinct_id, day ORDER BY ts
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS sn
      FROM marked
    )`;
};

export const analyticsSessions = async (
  ctx: AnalyticsDbCtx,
  opts: AnalyticsRange & { siteId?: string | null },
): Promise<AnalyticsSessions> => {
  const sessionCte = sessionCteSql(ctx, opts);

  const totalsQuery = sql`
    WITH ${sessionCte},
    agg AS (
      SELECT distinct_id, day, sn,
             COUNT(*) AS hits,
             MIN(ts) AS started,
             MAX(ts) AS ended
      FROM numbered GROUP BY distinct_id, day, sn
    )
    SELECT COUNT(*) AS sessions,
           SUM(hits) AS pageviews,
           SUM(CASE WHEN hits = 1 THEN 1 ELSE 0 END) AS bounces,
           SUM(${elapsedMsSql(ctx.dialect, "started", "ended")}) AS duration_ms
    FROM agg`;

  const pagesQuery = sql`
    WITH ${sessionCte},
    framed AS (
      SELECT distinct_id, day, sn, ts,
             FIRST_VALUE(path) OVER (
               PARTITION BY distinct_id, day, sn ORDER BY ts
               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
             ) AS landing,
             LAST_VALUE(path) OVER (
               PARTITION BY distinct_id, day, sn ORDER BY ts
               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
             ) AS exit_path
      FROM numbered
    ),
    one AS (
      SELECT distinct_id, day, sn, MIN(landing) AS landing, MIN(exit_path) AS exit_path
      FROM framed GROUP BY distinct_id, day, sn
    )
    SELECT landing, exit_path, distinct_id FROM one`;

  const [totalsRows, pageRows] = await Promise.all([
    runRaw<Record<string, unknown>>(ctx.db, ctx.dialect, totalsQuery),
    runRaw<{ landing: unknown; exit_path: unknown; distinct_id: unknown }>(
      ctx.db,
      ctx.dialect,
      pagesQuery,
    ),
  ]);

  const row = totalsRows[0] ?? {};
  const sessions = num(row.sessions);
  const pageviews = num(row.pageviews);
  const bounces = num(row.bounces);
  const durationMs = num(row.duration_ms);

  const tally = (pick: (r: (typeof pageRows)[number]) => unknown) => {
    const m = new Map<string, { count: number; users: Set<string> }>();
    for (const r of pageRows) {
      const key = pick(r);
      if (typeof key !== "string" || !key) continue;
      let hit = m.get(key);
      if (!hit) {
        hit = { count: 0, users: new Set() };
        m.set(key, hit);
      }
      hit.count++;
      hit.users.add(String(r.distinct_id));
    }
    return [...m.entries()]
      .map(([value, v]) => ({ value, count: v.count, users: v.users.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  };

  return {
    sessions,
    pageviews,
    bounceRate: sessions > 0 ? bounces / sessions : 0,
    avgDurationMs: sessions > 0 ? Math.round(durationMs / sessions) : 0,
    pagesPerSession: sessions > 0 ? pageviews / sessions : 0,
    landingPages: tally((r) => r.landing),
    exitPages: tally((r) => r.exit_path),
  };
};


/**
 * Read `props` WITHOUT letting the driver parse it.
 *
 * Selecting the column object makes Drizzle run its json mapper over the value
 * while assembling the result row — and a malformed blob throws there, inside
 * `mapResultRow`, before any code of ours sees it. That is not a hypothetical:
 * a row written by another tool, restored from a backup, or fixed by hand in
 * SQL can hold anything, and one of them would 500 an entire report. Worse, it
 * would also 500 the raw-event view, which is exactly where an operator would
 * go to find the bad row.
 *
 * Selecting a bare expression skips the mapper. What comes back then differs by
 * dialect — SQLite hands over the raw TEXT, Postgres hands over an already
 * parsed `jsonb` value — so {@link parseProps} accepts both.
 */
const propsRaw = sql<unknown>`props`;

/** Normalize whatever {@link propsRaw} yielded into an object, or null. */
const parseProps = (v: unknown): Record<string, unknown> | null => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v !== "string" || !v) return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A blob we cannot read is reported as absent, which is true and is the
    // only answer that keeps the rest of the row usable.
    return null;
  }
};

/* ── Segments ─────────────────────────────────────────────────────────── */

export interface AnalyticsSegmentRow {
  id: string;
  name: string;
  siteId: string | null;
  definition: unknown;
  createdAt: number;
  updatedAt: number;
}

const toSegmentRow = (r: any): AnalyticsSegmentRow => ({
  id: r.id,
  name: r.name,
  siteId: r.siteId ?? null,
  definition: r.definition ?? null,
  createdAt: tsValue(r.createdAt),
  updatedAt: tsValue(r.updatedAt),
});

export const listSegments = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
): Promise<AnalyticsSegmentRow[]> => {
  const t = segmentsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(tenantEq(t.tenantId, tenantId))
    .orderBy(t.name)) as any[];
  return rows.map(toSegmentRow);
};

/**
 * Resolve a saved segment id into a VALIDATED predicate tree.
 *
 * The stored blob is re-parsed on every read rather than trusted. A definition
 * saved under an older, looser validator must not keep working just because it
 * once passed — and a row edited outside the API has never passed at all.
 * An unknown id is `null`, which reports treat as "no filter"; an id belonging
 * to another workspace is also `null`, because the lookup is tenant-scoped.
 */
export const resolveSegment = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  id: string | null | undefined,
): Promise<SegmentNode | null> => {
  if (!id) return null;
  const t = segmentsTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select({ definition: t.definition })
    .from(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!row) return null;
  try {
    return parseSegment(row.definition);
  } catch {
    // A stored definition that no longer validates filters NOTHING rather than
    // filtering wrongly — and the segment list still shows it, so it can be
    // fixed. Silently reporting the whole workspace under a segment's name
    // would be the worse failure, so callers surface this as a warning.
    return null;
  }
};

export const createSegment = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  input: { name?: unknown; siteId?: unknown; definition?: unknown },
  createdBy: string | null,
  now = Date.now(),
): Promise<AnalyticsSegmentRow> => {
  const name = str(input.name, 120);
  if (!name) throw new AppError("VALIDATION", "A segment needs a name.");
  // Validate BEFORE storing. A definition that cannot compile must never reach
  // the table, or it becomes a segment that silently filters nothing.
  parseSegment(input.definition);

  const t = segmentsTable(ctx.dialect);
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    siteId: str(input.siteId, 64),
    name,
    definition: input.definition,
    createdBy,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  await (ctx.db as any).insert(t).values(row);
  return toSegmentRow(row);
};

export const updateSegment = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  id: string,
  input: { name?: unknown; siteId?: unknown; definition?: unknown },
  now = Date.now(),
): Promise<AnalyticsSegmentRow> => {
  const t = segmentsTable(ctx.dialect);
  const patch: Record<string, unknown> = { updatedAt: new Date(now) };
  if (input.name !== undefined) {
    const name = str(input.name, 120);
    if (!name) throw new AppError("VALIDATION", "A segment needs a name.");
    patch.name = name;
  }
  if (input.siteId !== undefined) patch.siteId = str(input.siteId, 64);
  if (input.definition !== undefined) {
    parseSegment(input.definition);
    patch.definition = input.definition;
  }

  await (ctx.db as any)
    .update(t)
    .set(patch)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));

  const [row] = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!row) throw new AppError("NOT_FOUND", "Segment not found.");
  return toSegmentRow(row);
};

export const deleteSegment = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  id: string,
): Promise<void> => {
  const t = segmentsTable(ctx.dialect);
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));
};

/* ── Revenue ──────────────────────────────────────────────────────────── */

/** Purchase rows read for the item breakdown. Items live in `props`, which has
 *  no portable SQL-side aggregation across pg/SQLite/D1, so they are tallied in
 *  JS from a bounded read rather than with a dialect-branching JSON query. */
const REVENUE_ROW_CAP = 5_000;

export interface AnalyticsRevenue {
  /** One row per currency. Never a single total — see the note below. */
  byCurrency: {
    currency: string;
    revenue: number;
    transactions: number;
    /** Average order value, in the same minor units. */
    aov: number;
  }[];
  byChannel: { channel: string; currency: string; revenue: number; transactions: number }[];
  byCampaign: { campaign: string; currency: string; revenue: number; transactions: number }[];
  topItems: { name: string; currency: string; quantity: number; revenue: number }[];
  truncated: boolean;
}

/**
 * Revenue, grouped by currency and attributed to the channel that brought the
 * session in.
 *
 * **Every figure carries its currency, and nothing is ever summed across
 * currencies.** There is no FX rate source in this repo, so a single "total
 * revenue" number would be an addition of quantities that are not commensurable
 * — 100 TRY + 100 EUR is not 200 of anything. Making `currency` part of every
 * row means the mistake is not available to a caller rather than merely
 * discouraged. Amounts stay in minor units end to end; only the UI divides.
 *
 * Items come from `props.items` — an array of `{ name, quantity, price }` — and
 * are tallied in JS. A `jsonb_array_elements` / `json_each` branch would be the
 * SQL answer, but it is the one shape whose spelling genuinely differs between
 * the dialects, and the read here is already bounded by `REVENUE_ROW_CAP`.
 */
export const analyticsRevenue = async (
  ctx: AnalyticsDbCtx,
  opts: AnalyticsRange & { siteId?: string | null },
): Promise<AnalyticsRevenue> => {
  const t = eventsTable(ctx.dialect);
  const clauses = [
    tenantEq(t.tenantId, opts.tenantId),
    gte(t.ts, tsParam(ctx.dialect, opts.from) as any),
    lte(t.ts, tsParam(ctx.dialect, opts.to) as any),
    sql`${t.revenue} IS NOT NULL`,
  ];
  if (opts.siteId) clauses.push(eq(t.siteId, opts.siteId));
  const revSeg = segmentWhere(ctx, opts);
  if (revSeg) clauses.push(revSeg);

  const rows = (await (ctx.db as any)
    .select({
      revenue: t.revenue,
      currency: t.currency,
      referrer: t.referrer,
      utmSource: t.utmSource,
      utmMedium: t.utmMedium,
      utmCampaign: t.utmCampaign,
      props: propsRaw,
    })
    .from(t)
    .where(and(...clauses))
    .orderBy(desc(t.ts))
    .limit(REVENUE_ROW_CAP + 1)) as any[];

  const truncated = rows.length > REVENUE_ROW_CAP;
  const use = truncated ? rows.slice(0, REVENUE_ROW_CAP) : rows;

  type Bucket = { revenue: number; transactions: number };
  const byCurrency = new Map<string, Bucket>();
  const byChannel = new Map<string, Bucket & { channel: string; currency: string }>();
  const byCampaign = new Map<string, Bucket & { campaign: string; currency: string }>();
  const items = new Map<string, { name: string; currency: string; quantity: number; revenue: number }>();

  for (const r of use) {
    const amount = Number(r.revenue);
    if (!Number.isFinite(amount)) continue;
    // An untagged currency is its own bucket rather than being folded into a
    // guess — "unknown" is a fact, a default currency would be a fiction.
    const currency = typeof r.currency === "string" && r.currency ? r.currency : "—";

    const cur = byCurrency.get(currency) ?? { revenue: 0, transactions: 0 };
    cur.revenue += amount;
    cur.transactions++;
    byCurrency.set(currency, cur);

    const touch = {
      referrer: typeof r.referrer === "string" ? r.referrer : null,
      utmSource: typeof r.utmSource === "string" ? r.utmSource : null,
      utmMedium: typeof r.utmMedium === "string" ? r.utmMedium : null,
    };
    const channel = classifyChannel(touch);
    const chKey = `${channel}\u0000${currency}`;
    const ch = byChannel.get(chKey) ?? { channel, currency, revenue: 0, transactions: 0 };
    ch.revenue += amount;
    ch.transactions++;
    byChannel.set(chKey, ch);

    const campaign =
      typeof r.utmCampaign === "string" && r.utmCampaign ? r.utmCampaign : "(none)";
    const cpKey = `${campaign}\u0000${currency}`;
    const cp = byCampaign.get(cpKey) ?? { campaign, currency, revenue: 0, transactions: 0 };
    cp.revenue += amount;
    cp.transactions++;
    byCampaign.set(cpKey, cp);

    // `props` is caller-supplied and may be anything at all — including a row
    // written directly to the table by some other tool. Every access below is
    // shape-checked, because one malformed blob must not 500 a revenue report.
    const props = parseProps(r.props);
    const list = props ? (props as any).items : null;
    if (Array.isArray(list)) {
      for (const raw of list.slice(0, 50)) {
        if (!raw || typeof raw !== "object") continue;
        const name = typeof (raw as any).name === "string" ? (raw as any).name.slice(0, 200) : null;
        if (!name) continue;
        const qty = Number((raw as any).quantity);
        const price = Number((raw as any).price);
        const key = `${name}\u0000${currency}`;
        const hit = items.get(key) ?? { name, currency, quantity: 0, revenue: 0 };
        hit.quantity += Number.isFinite(qty) ? qty : 1;
        if (Number.isFinite(price)) {
          hit.revenue += price * (Number.isFinite(qty) ? qty : 1);
        }
        items.set(key, hit);
      }
    }
  }

  const byRevenue = <T extends { revenue: number }>(a: T, b: T) => b.revenue - a.revenue;

  return {
    byCurrency: [...byCurrency.entries()]
      .map(([currency, v]) => ({
        currency,
        revenue: v.revenue,
        transactions: v.transactions,
        aov: v.transactions > 0 ? Math.round(v.revenue / v.transactions) : 0,
      }))
      .sort(byRevenue),
    byChannel: [...byChannel.values()].sort(byRevenue).slice(0, 12),
    byCampaign: [...byCampaign.values()].sort(byRevenue).slice(0, 10),
    topItems: [...items.values()].sort(byRevenue).slice(0, 10),
    truncated,
  };
};

/* ── Channels ─────────────────────────────────────────────────────────── */

export interface AnalyticsChannels {
  /** One row per Default Channel Group, ordered by sessions. */
  channels: { channel: string; sessions: number; visitors: number }[];
  /** GA4's `source / medium` breakdown, top 10. */
  sourceMedium: { value: string; sessions: number; visitors: number }[];
  totalSessions: number;
}

/**
 * Where sessions came from.
 *
 * Attribution here is **last non-direct touch WITHIN a session** — the session
 * is the unit, not the visitor. That limit is a direct consequence of the
 * cookieless identity: a visitor id rotates at UTC midnight, so "the campaign
 * that brought them here three days ago" is a join we cannot make. The UI says
 * so rather than letting the number be read as GA4-equivalent.
 *
 * Within a session, the touch carrying attribution wins over a bare direct
 * hit regardless of order — a visitor who lands on a bookmarked page and then
 * clicks an emailed link in the same session came from Email, and ordering
 * strictly by time would file that as Direct.
 */
export const analyticsChannels = async (
  ctx: AnalyticsDbCtx,
  opts: AnalyticsRange & { siteId?: string | null },
): Promise<AnalyticsChannels> => {
  const query = sql`
    WITH ${sessionCteSql(ctx, opts)},
    ranked AS (
      SELECT distinct_id, day, sn, referrer, utm_source, utm_medium,
             ROW_NUMBER() OVER (
               PARTITION BY distinct_id, day, sn
               ORDER BY
                 CASE WHEN (referrer IS NOT NULL AND referrer <> '')
                            OR (utm_source IS NOT NULL AND utm_source <> '')
                       THEN 0 ELSE 1 END,
                 ts
             ) AS rn
      FROM numbered
    )
    SELECT distinct_id, referrer, utm_source, utm_medium
    FROM ranked WHERE rn = 1`;

  const rows = await runRaw<{
    distinct_id: unknown;
    referrer: unknown;
    utm_source: unknown;
    utm_medium: unknown;
  }>(ctx.db, ctx.dialect, query);

  const asText = (v: unknown) => (typeof v === "string" ? v : null);
  const byChannel = new Map<string, { sessions: number; users: Set<string> }>();
  const bySourceMedium = new Map<string, { sessions: number; users: Set<string> }>();

  const bump = (
    m: Map<string, { sessions: number; users: Set<string> }>,
    key: string,
    who: string,
  ) => {
    let hit = m.get(key);
    if (!hit) {
      hit = { sessions: 0, users: new Set() };
      m.set(key, hit);
    }
    hit.sessions++;
    hit.users.add(who);
  };

  for (const r of rows) {
    const touch = {
      referrer: asText(r.referrer),
      utmSource: asText(r.utm_source),
      utmMedium: asText(r.utm_medium),
    };
    const who = String(r.distinct_id);
    bump(byChannel, classifyChannel(touch), who);
    bump(bySourceMedium, sourceMediumLabel(touch), who);
  }

  const shape = (m: Map<string, { sessions: number; users: Set<string> }>, limit: number) =>
    [...m.entries()]
      .map(([value, v]) => ({ value, sessions: v.sessions, visitors: v.users.size }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, limit);

  return {
    channels: shape(byChannel, 12).map((r) => ({
      channel: r.value,
      sessions: r.sessions,
      visitors: r.visitors,
    })),
    sourceMedium: shape(bySourceMedium, 10),
    totalSessions: rows.length,
  };
};

/* ── Realtime ─────────────────────────────────────────────────────────── */

/** Minutes in the realtime window. GA calls this "last 30 minutes". */
export const REALTIME_MINUTES = 30;

/**
 * Rows one realtime call will read.
 *
 * The window is bounded by time, not by volume, so a busy site could put an
 * unbounded number of rows inside it — and this endpoint is polled. The cap
 * makes the cost predictable; `truncated` says when it bit, because a silently
 * clipped "visitors right now" is a wrong number that still renders.
 */
const REALTIME_ROW_CAP = 5_000;

export interface AnalyticsRealtime {
  /** Distinct visitors seen in the window. */
  visitorsNow: number;
  events: number;
  /** Oldest-first, one point per minute, zero-filled. Always REALTIME_MINUTES long. */
  byMinute: { minute: number; events: number; visitors: number }[];
  topPaths: AnalyticsBreakdownRow[];
  topReferrers: AnalyticsBreakdownRow[];
  topCountries: AnalyticsBreakdownRow[];
  /** True when the row cap bit and the figures below it are a floor, not a total. */
  truncated: boolean;
}

/**
 * "Who is on the site right now."
 *
 * Deliberately NOT built on the `hour` column. Hourly buckets are the wrong
 * grain for a 30-minute view, and the whole point of materializing `hour` was
 * to dodge date functions for LONG ranges. Here the range is short and bounded,
 * so one narrow query plus JS bucketing is both cheaper and free of any dialect
 * branch — there is no portable minute-truncation expression to write.
 */
export const analyticsRealtime = async (
  ctx: AnalyticsDbCtx,
  opts: {
    tenantId: string | null;
    siteId?: string | null;
    /** Optional saved-segment predicate, already validated by `parseSegment`. */
    segment?: SegmentNode | null;
  },
  now = Date.now(),
): Promise<AnalyticsRealtime> => {
  const t = eventsTable(ctx.dialect);
  const windowMs = REALTIME_MINUTES * 60_000;
  // Anchor on a whole minute so buckets are stable between polls — otherwise
  // every refresh shifts the boundaries and the chart shimmers.
  const end = Math.floor(now / 60_000) * 60_000 + 60_000;
  const from = end - windowMs;

  const clauses = [
    tenantEq(t.tenantId, opts.tenantId),
    gte(t.ts, tsParam(ctx.dialect, from) as any),
  ];
  if (opts.siteId) clauses.push(eq(t.siteId, opts.siteId));
  const rtSeg = opts.segment
    ? compileSegment(
        { dialect: ctx.dialect, table: eventsTable(ctx.dialect) as never },
        opts.segment,
      )
    : undefined;
  if (rtSeg) clauses.push(rtSeg);

  const rows = (await (ctx.db as any)
    .select({
      ts: t.ts,
      distinctId: t.distinctId,
      path: t.path,
      referrer: t.referrer,
      country: t.country,
    })
    .from(t)
    .where(and(...clauses))
    .orderBy(desc(t.ts))
    .limit(REALTIME_ROW_CAP + 1)) as any[];

  const truncated = rows.length > REALTIME_ROW_CAP;
  const use = truncated ? rows.slice(0, REALTIME_ROW_CAP) : rows;

  const buckets = Array.from({ length: REALTIME_MINUTES }, (_, i) => ({
    minute: from + i * 60_000,
    events: 0,
    visitors: new Set<string>(),
  }));
  const seen = new Set<string>();
  const byPath = new Map<string, { count: number; users: Set<string> }>();
  const byReferrer = new Map<string, { count: number; users: Set<string> }>();
  const byCountry = new Map<string, { count: number; users: Set<string> }>();

  const bump = (
    m: Map<string, { count: number; users: Set<string> }>,
    key: unknown,
    who: string,
  ) => {
    if (typeof key !== "string" || !key) return;
    let hit = m.get(key);
    if (!hit) {
      hit = { count: 0, users: new Set() };
      m.set(key, hit);
    }
    hit.count++;
    hit.users.add(who);
  };

  for (const r of use) {
    const ms = tsValue(r.ts);
    const who = String(r.distinctId);
    seen.add(who);
    const idx = Math.floor((ms - from) / 60_000);
    const bucket = buckets[idx];
    if (bucket) {
      bucket.events++;
      bucket.visitors.add(who);
    }
    bump(byPath, pathWithoutQuery(typeof r.path === "string" ? r.path : null), who);
    bump(byReferrer, r.referrer, who);
    bump(byCountry, r.country, who);
  }

  const top = (m: Map<string, { count: number; users: Set<string> }>) =>
    [...m.entries()]
      .map(([value, v]) => ({ value, count: v.count, users: v.users.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

  return {
    visitorsNow: seen.size,
    events: use.length,
    byMinute: buckets.map((b) => ({
      minute: b.minute,
      events: b.events,
      visitors: b.visitors.size,
    })),
    topPaths: top(byPath),
    topReferrers: top(byReferrer),
    topCountries: top(byCountry),
    truncated,
  };
};

/* ── Sites ────────────────────────────────────────────────────────────── */

export interface AnalyticsSiteRow {
  id: string;
  name: string;
  domain: string;
  tz: string;
  excludedPaths: string[];
  ignoredIps: string[];
  filterBots: boolean;
  requireKnownOrigin: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Reduce whatever a caller sent to a bare lowercase host. Accepts a full URL,
 *  a host with a port, or a bare host — operators paste all three. */
export const normalizeDomain = (raw: string): string => {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return "";
  const withScheme = t.includes("://") ? t : `https://${t}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    return t.replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0] ?? "";
  }
};

/**
 * Is this the host a browser would resolve, unchanged?
 *
 * `normalizeDomain` already punycodes and strips scheme/port/path, so what is
 * left is whether the result is a host at all. The CHARACTER test is what
 * decides, not the `new URL()` round-trip below it, because the round-trip does
 * not mean the same thing everywhere: Node, Bun and workerd all throw on
 * `https://my site.com`, while a browser percent-encodes it into
 * `my%20site.com` and hands it back as a valid hostname. This repo ships four
 * runtimes and mirrors this rule into the admin form, so the check cannot rest
 * on which parser happens to be underneath.
 *
 * `localhost`, a bare IP and a bracketed IPv6 literal are hosts and pass on
 * purpose; `_` is tolerated because it turns up in real internal names.
 */
const HOST_CHARS = /^[a-z0-9._-]+$/;
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

const isResolvableHost = (host: string): boolean => {
  if (!host) return false;
  if (IPV6_LITERAL.test(host)) return true;
  if (!HOST_CHARS.test(host)) return false;
  // Every label has to be a label: `..`, `a..b` and a bare `-` clear the
  // character test and are still not names anything resolves.
  if (!host.split(".").every((label) => label.length > 0 && /[a-z0-9]/.test(label))) {
    return false;
  }
  try {
    return new URL(`https://${host}`).hostname === host;
  } catch {
    return false;
  }
};

/**
 * The domain is the field that decides whether anything is collected at all.
 *
 * `require_known_origin` defaults to true and compares this value against the
 * real request origin, so a domain the browser can never send — `my site`,
 * `admin`, a pasted sentence — silently drops every event with a 202 and no
 * error anywhere. It was only ever checked for "not empty", which is the one
 * bad value an operator would notice.
 */
const assertDomain = (raw: string): string => {
  const domain = normalizeDomain(raw);
  if (!domain) throw new AppError("VALIDATION", "A site needs a domain.");
  if (!isResolvableHost(domain)) {
    throw new AppError(
      "VALIDATION",
      `"${raw.trim()}" is not a domain. Use a host like example.com — a full URL is fine, but a space or a path is not.`,
    );
  }
  return domain;
};

/**
 * Exclusion patterns that can actually match.
 *
 * `pathExcluded` compares against `location.pathname` with the query string
 * already stripped, and an entry with no `*` is an EXACT comparison. So
 * `admin` (no leading slash) and `/search?q=x` (a query) are not narrow rules —
 * they are rules that can never fire, stored under a toast reading "saved".
 * A bare `*` is refused for the opposite reason: it matches every path, which
 * turns measurement off for the whole site in one keystroke.
 */
const assertPaths = (list: string[]): string[] => {
  for (const entry of list) {
    if (entry === "*" || entry === "**") {
      throw new AppError(
        "VALIDATION",
        `"${entry}" would exclude every page. Name a path, or use a prefix like /admin/*.`,
      );
    }
    if (/[\s?#]/.test(entry)) {
      throw new AppError(
        "VALIDATION",
        `"${entry}" cannot match: paths are compared without the query string, and may not contain a space.`,
      );
    }
    if (!entry.startsWith("/") && !entry.startsWith("*")) {
      throw new AppError(
        "VALIDATION",
        `"${entry}" cannot match: a path starts with / — try "/${entry}" or "*${entry}".`,
      );
    }
  }
  return list;
};

/** IPv4, or something the URL parser accepts as an IPv6 literal. */
const isIpAddress = (value: string): boolean => {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((o) => Number(o) <= 255);
  }
  try {
    return new URL(`https://[${value}]`).hostname === `[${value.toLowerCase()}]`;
  } catch {
    return false;
  }
};

/**
 * Addresses that can actually match.
 *
 * The collect route compares `ignoredIps` to the request IP with an exact
 * `includes`, so a label ("office"), a range ("203.0.113.0/24") or a host name
 * is not a loose filter — it is one that never fires. Ranges are called out by
 * name because they are the plausible mistake.
 */
const assertIps = (list: string[]): string[] => {
  for (const entry of list) {
    if (entry.includes("/")) {
      throw new AppError(
        "VALIDATION",
        `"${entry}" looks like a range. Ranges are not matched — list the addresses themselves.`,
      );
    }
    if (!isIpAddress(entry)) {
      throw new AppError(
        "VALIDATION",
        `"${entry}" is not an IP address. The request IP is compared exactly, so only a literal address can match.`,
      );
    }
  }
  return list;
};

const strList = (v: unknown, max: number): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
};

const toSiteRow = (r: any): AnalyticsSiteRow => ({
  id: r.id,
  name: r.name,
  domain: r.domain,
  tz: r.tz ?? "UTC",
  excludedPaths: Array.isArray(r.excludedPaths) ? r.excludedPaths : [],
  ignoredIps: Array.isArray(r.ignoredIps) ? r.ignoredIps : [],
  filterBots: Boolean(r.filterBots),
  requireKnownOrigin: Boolean(r.requireKnownOrigin),
  createdAt: tsValue(r.createdAt),
  updatedAt: tsValue(r.updatedAt),
});

export const listSites = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
): Promise<AnalyticsSiteRow[]> => {
  const t = sitesTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(tenantEq(t.tenantId, tenantId))
    .orderBy(t.domain)) as any[];
  return rows.map(toSiteRow);
};

/** Resolve a site for the collect route. Tenant is derived FROM the site —
 *  the tag has no other credential — so this is the one lookup that may not
 *  be tenant-scoped, and it is keyed on a primary key. */
export const getSiteById = async (
  ctx: AnalyticsDbCtx,
  id: string,
): Promise<(AnalyticsSiteRow & { tenantId: string | null }) | null> => {
  if (!id) return null;
  const t = sitesTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.id, id))
    .limit(1)) as any[];
  return row ? { ...toSiteRow(row), tenantId: row.tenantId ?? null } : null;
};

export interface SiteInput {
  name?: string | null;
  domain?: string | null;
  tz?: string | null;
  excludedPaths?: unknown;
  ignoredIps?: unknown;
  filterBots?: boolean | null;
  requireKnownOrigin?: boolean | null;
}

export const createSite = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  input: SiteInput,
  now = Date.now(),
): Promise<AnalyticsSiteRow> => {
  const name = str(input.name, 120);
  if (!name) throw new AppError("VALIDATION", "A site needs a name.");
  const domain = assertDomain(String(input.domain ?? ""));

  const t = sitesTable(ctx.dialect);
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    name,
    domain,
    tz: str(input.tz, 60) ?? "UTC",
    excludedPaths: assertPaths(strList(input.excludedPaths, 50)),
    ignoredIps: assertIps(strList(input.ignoredIps, 50)),
    filterBots: input.filterBots !== false,
    requireKnownOrigin: input.requireKnownOrigin !== false,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  await (ctx.db as any).insert(t).values(row);
  return toSiteRow(row);
};

export const updateSite = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  id: string,
  input: SiteInput,
  now = Date.now(),
): Promise<AnalyticsSiteRow> => {
  const t = sitesTable(ctx.dialect);
  const patch: Record<string, unknown> = { updatedAt: new Date(now) };
  if (input.name !== undefined) {
    const name = str(input.name, 120);
    if (!name) throw new AppError("VALIDATION", "A site needs a name.");
    patch.name = name;
  }
  if (input.domain !== undefined) patch.domain = assertDomain(String(input.domain ?? ""));
  if (input.tz !== undefined) patch.tz = str(input.tz, 60) ?? "UTC";
  if (input.excludedPaths !== undefined)
    patch.excludedPaths = assertPaths(strList(input.excludedPaths, 50));
  if (input.ignoredIps !== undefined)
    patch.ignoredIps = assertIps(strList(input.ignoredIps, 50));
  if (input.filterBots !== undefined) patch.filterBots = input.filterBots !== false;
  if (input.requireKnownOrigin !== undefined)
    patch.requireKnownOrigin = input.requireKnownOrigin !== false;

  // Tenant-scoped on the UPDATE itself, not checked-then-written: a read
  // followed by a write is a cross-tenant race, and this is a workspace's
  // measurement config.
  await (ctx.db as any)
    .update(t)
    .set(patch)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));

  const [row] = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!row) throw new AppError("NOT_FOUND", "Site not found.");
  return toSiteRow(row);
};

export const deleteSite = async (
  ctx: AnalyticsDbCtx,
  tenantId: string | null,
  id: string,
): Promise<void> => {
  const t = sitesTable(ctx.dialect);

  // Ownership is established BEFORE anything is removed, and the cascade is
  // gated on it.
  //
  // The ordering matters. Checking afterwards ("is the site gone now?") reads
  // as equivalent and is not: a `site_id` that has a policy but no site row —
  // left by a backfill or a direct write — would look "gone" to any caller, so
  // whoever guessed the id could delete a policy belonging to a workspace that
  // is not theirs. An orphan is already inert, but a delete primitive that
  // works across tenants should not exist at all.
  const [owned] = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!owned) return;

  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.id, id), tenantEq(t.tenantId, tenantId)));

  // Cascade the consent policy by hand. There is no foreign key — D1 has them
  // off, so a constraint that exists only on Postgres is a dialect difference
  // pretending to be an invariant — and an orphan here is not merely untidy: it
  // is keyed on `site_id`, so the admin console (which iterates SITES) can
  // neither show it nor remove it, while the row stays live.
  await deletePolicyForDeletedSite(ctx, id);
  // …and the visitor decisions recorded against it. Deleting a site removes the
  // subject of the evidence, which is the one case where evidence does go with
  // the configuration. Called from here rather than from `deletePolicy*` so the
  // policy module and the records module do not have to import each other.
  await deleteSiteRecords(ctx, id);
};

/**
 * Persist tag-originated events.
 *
 * Separate from {@link recordEvents} because the two lanes differ in exactly
 * the ways that matter: the visitor id is server-derived rather than
 * caller-supplied, `id_scope` is `daily`, and every row is pinned to a site.
 * Sharing one function would mean a caller-controlled `idScope`, which is the
 * one field no caller may set.
 */
export const recordWebEvents = async (
  ctx: AnalyticsDbCtx,
  opts: { tenantId: string | null; siteId: string; distinctId: string },
  input: TrackEventInput[],
  now = Date.now(),
): Promise<{ accepted: number; rejected: number }> =>
  recordEvents(
    ctx,
    opts.tenantId,
    input.map((e) => ({
      ...e,
      distinctId: opts.distinctId,
      siteId: opts.siteId,
      idScope: "daily" as const,
    })),
    now,
  );

/* ── Overview ─────────────────────────────────────────────────────────── */

export interface AnalyticsRange {
  tenantId: string | null;
  /** Inclusive epoch-ms bounds. */
  from: number;
  to: number;
  /** Optional: limit to one registered site. */
  siteId?: string | null;
  /**
   * Optional saved-segment predicate, ALREADY VALIDATED.
   *
   * Reports take the parsed tree rather than an id so the trust boundary is
   * unambiguous: whatever reaches a query here has been through
   * `parseSegment`, and a report cannot accidentally be handed raw JSON.
   */
  segment?: SegmentNode | null;
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
  | "pathBase"
  | "referrer"
  | "source"
  | "country"
  | "deviceType"
  | "browser"
  | "os"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign";

/**
 * Builder-side segment predicate for a report, or `undefined`.
 *
 * Kept as a one-liner so every report applies it the same way — a report that
 * forgets it silently ignores the operator's filter and reports the whole
 * workspace, which looks like working software.
 */
const segmentWhere = (ctx: AnalyticsDbCtx, range: AnalyticsRange) =>
  range.segment
    ? compileSegment(
        { dialect: ctx.dialect, table: eventsTable(ctx.dialect) as never },
        range.segment,
      )
    : undefined;

/** Raw-SQL twin, appended to a CTE's WHERE. */
const segmentSql = (ctx: AnalyticsDbCtx, range: AnalyticsRange) => {
  const frag = range.segment ? compileSegmentRaw(ctx.dialect, range.segment) : undefined;
  return frag ? sql` AND ${frag}` : sql``;
};

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
        ...(range.siteId ? [eq(t.siteId, range.siteId)] : []),
        ...(segmentWhere(ctx, range) ? [segmentWhere(ctx, range) as any] : []),
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
  const seg = segmentWhere(ctx, range);
  const inRange = and(
    tenantEq(t.tenantId, range.tenantId),
    gte(t.ts, tsParam(ctx.dialect, range.from) as any),
    lte(t.ts, tsParam(ctx.dialect, range.to) as any),
    ...(range.siteId ? [eq(t.siteId, range.siteId)] : []),
    ...(seg ? [seg] : []),
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
      // Grouped on the query-stripped key, so one page is one row however many
      // campaign variants pointed at it.
      topBy(ctx, range, "pathBase", 10),
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
          AND ts >= ${from} AND ts <= ${to} AND ${durableOnly()}${segmentSql(ctx, opts)}
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
      WHERE ${tenantSql(opts.tenantId)}${nameFilter} AND ${durableOnly()}${segmentSql(ctx, opts)}
      GROUP BY distinct_id
      HAVING MIN(day) >= ${fromDay} AND MIN(day) <= ${toDay}
    ),
    a AS (
      SELECT DISTINCT distinct_id, day FROM analytics_events
      WHERE ${tenantSql(opts.tenantId)}${nameFilter} AND ${durableOnly()}${segmentSql(ctx, opts)}
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
  /** `path` with the query removed — what page reports group by. */
  pathBase: string | null;
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

  // Explicit columns with `props` read raw: selecting the whole table would
  // run Drizzle's json mapper, and a malformed blob would throw while building
  // the row — taking down the one view that could show you which row it is.
  const rows = (await (ctx.db as any)
    .select({
      id: t.id,
      name: t.name,
      distinctId: t.distinctId,
      userId: t.userId,
      sessionId: t.sessionId,
      props: propsRaw,
      path: t.path,
      pathBase: t.pathBase,
      referrer: t.referrer,
      source: t.source,
      release: t.release,
      country: t.country,
      siteId: t.siteId,
      idScope: t.idScope,
      deviceType: t.deviceType,
      browser: t.browser,
      os: t.os,
      utmSource: t.utmSource,
      utmMedium: t.utmMedium,
      utmCampaign: t.utmCampaign,
      revenue: t.revenue,
      currency: t.currency,
      ts: t.ts,
    })
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
    props: parseProps(r.props),
    path: r.path ?? null,
    pathBase: r.pathBase ?? null,
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
