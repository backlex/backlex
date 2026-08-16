/**
 * Advisor — automated lint over live schema, permissions, config, and traffic.
 *
 * Every check here is computed from real DB / env state. No statistics are
 * fabricated. There are two families of performance check and they are
 * deliberately distinct:
 *
 *  - **static, schema-derived** — introspect which physical indexes exist (via
 *    dialect-specific catalog queries) and flag collections whose *implied* hot
 *    paths (owner_id filter, `-created_at` sort) have no covering index. These
 *    fire on a workspace with zero traffic, because they reason about the
 *    schema alone.
 *  - **runtime, traffic-derived** (v2) — aggregate the `spans` rows the request
 *    middleware already writes (`services/advisor-insights.ts`) and flag what
 *    actually happened: endpoints whose p95 is slow, endpoints returning 5xx,
 *    and columns real list traffic filters/sorts on that have no index. Every
 *    such finding quotes the observed numbers and the window they came from.
 *
 * When runtime evidence exists for a (table, column) pair, the traffic-backed
 * finding wins and the static one is suppressed — one finding per real problem,
 * and the more informative one survives.
 *
 * Findings that a server-built DDL statement can fix carry an `action`; see
 * `routes/advisor.ts` for the apply path, which re-derives the statement rather
 * than trusting anything the client sends.
 *
 * Keep this file pure-ish: it only reads from `ctx.db` + `ctx.env` and
 * returns plain findings + a derived score. The route (`routes/advisor.ts`)
 * stays thin. Every check is wrapped in try/catch and skips silently when a
 * table isn't migrated yet.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { Env } from "../env";
import { loadEmailConfigRow } from "./email-config";
import { loadSmsConfigRow } from "./sms-config";
import { loadPushConfigRow } from "./push-config";
import { selectSmsSpec } from "../lib/sms-select";
import { selectPushSpec } from "../lib/push-select";
import { cloudConfigured } from "../lib/cloud-report";
import { loadBackupConfig } from "./backup";
import { recordActivity } from "./activity";
import {
  type RuntimeInsights,
  collectionFromPath,
  loadRuntimeInsights,
} from "./advisor-insights";

export type AdvisorKind = "security" | "performance";
export type AdvisorLevel = "error" | "warn" | "info";

/**
 * A remediation the server can carry out itself. Only ever produced by the
 * advisor — the apply endpoint re-runs the checks and matches by finding id, so
 * the `sql` below is never taken from client input.
 */
export interface AdvisorAction {
  type: "create-index";
  /** Physical table the index lands on. */
  table: string;
  /** Index name the statement creates. */
  indexName: string;
  /** Indexed columns, in index order. */
  columns: string[];
  /** The exact statement the apply endpoint runs. */
  sql: string;
}

export interface AdvisorCheck {
  id: string;
  kind: AdvisorKind;
  level: AdvisorLevel;
  /** Stable rule-family identifier. Findings sharing a `rule` are grouped. */
  rule: string;
  /** Category label shown when several findings share the same `rule`. */
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  /** Optional admin SPA route path to the relevant surface. */
  link?: string;
  /** Present when the advisor can apply the fix itself. */
  action?: AdvisorAction;
  /** Observed numbers behind a traffic-derived finding. Absent on static and
   *  security findings — its presence is what marks a finding as measured. */
  evidence?: {
    /** Requests observed in the window (spans seen, not extrapolated). */
    requests: number;
    windowDays: number;
    p95?: number;
    errorRate?: number;
    /** Share of the collection's list traffic touching the column, 0..1. */
    share?: number;
  };
}

export interface AdvisorResult {
  data: AdvisorCheck[];
  /** 0–100 health score derived from all findings. */
  score: number;
  /** ISO timestamp — one honest value per run. */
  generatedAt: string;
  /** What the traffic-derived rules had to work with this run. `spanCount: 0`
   *  means no runtime finding could fire, which is different from "no problems
   *  found" — the UI says so rather than implying a clean bill of health. */
  runtime: {
    windowDays: number;
    spanCount: number;
    sampleRate: number;
    truncated: boolean;
  };
}

interface AdvisorCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
  env: Env;
  /**
   * The resolved image transformer, when the caller has one to give.
   *
   * Optional because every call site hand-builds a narrow `{db, dialect, env}`
   * rather than passing the whole `Ctx`, and because the one rule that reads it
   * is allowed to say nothing when it cannot tell. `name` is the adapter's own
   * diagnostic id (`bun-image`, `sharp`, `passthrough`) — the contract already
   * declares it for exactly this purpose.
   */
  image?: { name: string };
  /** URL-based edge resize backend (CF Images / Netlify Image CDN), when the
   *  runtime has one. Its presence is what makes a `passthrough` in-process
   *  adapter harmless, so the rule below has to see it. */
  edgeImage?: unknown;
}

/** Thresholds for the traffic-derived rules. Deliberately conservative: a rule
 *  that fires on three requests is noise, not advice. */
const RUNTIME = {
  /** Default aggregation window. */
  windowDays: 7,
  /** Minimum requests before latency/index advice is worth giving. */
  minRequests: 20,
  /** Minimum requests before error-rate advice is worth giving. */
  minErrorRequests: 10,
  /** p95 at or above this is "slow". */
  slowP95Ms: 500,
  /** p95 at or above this is escalated from warn to error. */
  verySlowP95Ms: 2000,
  /** 5xx share at or above this is a finding. */
  errorRate: 0.05,
  /** A filter column used on at least this share of a collection's list
   *  traffic is worth an index. */
  filterShare: 0.2,
  /** Sorting names a column on essentially every list request (the default
   *  sort counts), so the bar is higher than for filters. */
  sortShare: 0.5,
  /** Cap per rule so a broken deploy can't flood the page. */
  maxFindingsPerRule: 5,
} as const;

const schemaFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema : sqlite.schema;

/** True when the deployment env has complete credentials for a real
 *  (non-console) email transport. Mirrors `selectEmailAdapter`'s auto-detect
 *  without instantiating an adapter. */
const envHasRealEmailProvider = (env: Env): boolean => {
  const explicit = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (explicit === "console") return false;
  const from = env.EMAIL_FROM;
  if (!from) return false;
  return Boolean(
    env.RESEND_API_KEY ||
      env.SENDGRID_API_KEY ||
      (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN) ||
      (env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY && env.SES_REGION) ||
      env.SMTP_HOST,
  );
};

/** Compute the health score from all findings. */
const computeScore = (findings: AdvisorCheck[]): number => {
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  return Math.max(0, 100 - errors * 18 - warns * 7);
};

/** Run a raw SQL query against either dialect, normalising the result to a
 *  plain row array (mirrors `services/adopt.ts::runQuery`). */
const runRaw = async <T>(
  db: any,
  dialect: "pg" | "sqlite",
  query: ReturnType<typeof sql.raw>,
): Promise<T[]> => {
  if (dialect === "pg") {
    const r = (await db.execute(query)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) {
      return (r as { rows: T[] }).rows;
    }
    return r as T[];
  }
  return (await db.all(query)) as T[];
};

/**
 * Every index on the table as an ordered list of its column names.
 * Dialect-specific catalog introspection; throws are caught by the caller so a
 * check skips gracefully.
 *
 * The full column order matters: a managed collection's pagination index is
 * `(tenant_id, created_at, id)`, and reading only the leading column would call
 * `created_at` unindexed when in practice every tenant-scoped query pins
 * `tenant_id` and uses that index. See {@link isColumnCovered}.
 */
const tableIndexes = async (
  db: any,
  dialect: "pg" | "sqlite",
  table: string,
): Promise<string[][]> => {
  const out: string[][] = [];
  const safe = table.replace(/"/g, '""');
  if (dialect === "sqlite") {
    // PRAGMA index_list → each index; PRAGMA index_info → its columns.
    const idxList = await runRaw<{ name: string }>(
      db,
      dialect,
      sql.raw(`PRAGMA index_list("${safe}")`),
    );
    for (const idx of idxList) {
      if (!idx?.name) continue;
      const idxSafe = idx.name.replace(/"/g, '""');
      const info = await runRaw<{ seqno: number | string; name: string }>(
        db,
        dialect,
        sql.raw(`PRAGMA index_info("${idxSafe}")`),
      );
      const cols = [...info]
        .filter((c) => c?.name)
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c) => c.name);
      if (cols.length) out.push(cols);
    }
  } else {
    // PG: `indkey` is the ordered attnum vector; unnest it WITH ORDINALITY so
    // the index's column order survives the join.
    const rows = await runRaw<{ idx: string; col: string; ord: number | string }>(
      db,
      dialect,
      sql.raw(
        `SELECT i.indexrelid::text AS idx, a.attname AS col, k.ord AS ord
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
          WHERE t.relname = '${safe.replace(/'/g, "''")}'
            AND n.nspname = current_schema()
          ORDER BY i.indexrelid, k.ord`,
      ),
    );
    const byIndex = new Map<string, { ord: number; col: string }[]>();
    for (const r of rows) {
      if (!r?.idx || !r.col) continue;
      const list = byIndex.get(r.idx) ?? [];
      list.push({ ord: Number(r.ord), col: r.col });
      byIndex.set(r.idx, list);
    }
    for (const list of byIndex.values()) {
      out.push(list.sort((a, b) => a.ord - b.ord).map((e) => e.col));
    }
  }
  return out;
};

/**
 * Columns every items query constrains by equality, so an index whose leading
 * columns are all in this set still serves a filter/sort on a later column.
 * `tenant_id` is applied by `tenantFilter` on every read of a managed
 * collection — which is exactly why the `(tenant_id, created_at, id)`
 * pagination index really does cover a `-created_at` sort.
 */
const ALWAYS_PINNED_COLUMNS = new Set(["tenant_id"]);

/**
 * True when some index can serve a filter/sort on `column`: either it leads an
 * index, or every column before it in a composite index is pinned by equality
 * on every query.
 */
const isColumnCovered = (indexes: string[][], column: string): boolean =>
  indexes.some((cols) => {
    const at = cols.indexOf(column);
    if (at < 0) return false;
    return cols.slice(0, at).every((c) => ALWAYS_PINNED_COLUMNS.has(c));
  });

/**
 * The physical table's real column names. Used to gate index advice: a column
 * name reaches us via a span attribute, and even though the list handler only
 * ever records names it validated against the collection's field defs, an index
 * finding is only emitted for a column the catalog confirms exists.
 */
const tableColumns = async (
  db: any,
  dialect: "pg" | "sqlite",
  table: string,
): Promise<Set<string>> => {
  const cols = new Set<string>();
  const safe = table.replace(/"/g, '""');
  if (dialect === "sqlite") {
    const rows = await runRaw<{ name: string }>(
      db,
      dialect,
      sql.raw(`PRAGMA table_info("${safe}")`),
    );
    for (const r of rows) if (r?.name) cols.add(r.name);
  } else {
    const rows = await runRaw<{ column_name: string }>(
      db,
      dialect,
      sql.raw(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_name = '${safe.replace(/'/g, "''")}'
            AND table_schema = current_schema()`,
      ),
    );
    for (const r of rows) if (r?.column_name) cols.add(r.column_name);
  }
  return cols;
};

/** SQL identifiers the advisor is willing to interpolate. Both sides of an
 *  index statement are already catalog-verified by the time we build it; this
 *  is the belt-and-braces gate that keeps a DDL string from ever carrying
 *  anything but a plain identifier. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Deterministic index name for a (table, columns) pair, kept inside PG's
 *  63-byte identifier limit. Deterministic so re-running the advisor after an
 *  apply produces the same name and the `IF NOT EXISTS` is a real no-op. */
export const advisorIndexName = (table: string, columns: string[]): string => {
  const base = `bx_idx_${table}_${columns.join("_")}`;
  if (base.length <= 63) return base;
  // Truncate, but keep the tail distinct by folding a cheap checksum in.
  let hash = 0;
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  return `${base.slice(0, 54)}_${hash.toString(36)}`;
};

/**
 * Build the `create-index` action for a (table, columns) pair, or null when any
 * identifier fails the safety gate. Both dialects support
 * `CREATE INDEX IF NOT EXISTS`, so applying twice is harmless.
 */
const createIndexAction = (
  table: string,
  columns: string[],
): AdvisorAction | null => {
  if (!SAFE_IDENT.test(table)) return null;
  if (columns.length === 0 || !columns.every((c) => SAFE_IDENT.test(c))) return null;
  const indexName = advisorIndexName(table, columns);
  const cols = columns.map((c) => `"${c}"`).join(", ");
  return {
    type: "create-index",
    table,
    indexName,
    columns,
    sql: `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" (${cols})`,
  };
};

/** `12.4%` — share formatting shared by every traffic-derived body string. */
const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/**
 * Run every advisor check against live state. Tenant-scoped: `tenantId`
 * narrows the `collections` / `roles` rows that are inspected so a workspace
 * only sees findings about its own schema and permissions.
 *
 * `opts.insights` lets a caller (the apply endpoint, tests) pass an already
 * computed aggregation instead of paying for a second pass over `spans`.
 */
export const runAdvisorChecks = async (
  ctx: AdvisorCtx,
  tenantId: string | null,
  opts: { windowDays?: number; insights?: RuntimeInsights } = {},
): Promise<AdvisorResult> => {
  const s = schemaFor(ctx.dialect);
  const db = ctx.db as any;
  const out: AdvisorCheck[] = [];
  const windowDays = opts.windowDays ?? RUNTIME.windowDays;

  // --- SECURITY ----------------------------------------------------------

  // Public read with no condition: the `public` role can list a collection
  // with no DSL guard at all — anonymous traffic can read every row.
  try {
    const publicReads = await db
      .select({
        collection: s.permissions.collection,
      })
      .from(s.permissions)
      .innerJoin(s.roles, eq(s.permissions.roleId, s.roles.id))
      .where(
        and(
          eq(s.roles.name, "public"),
          eq(s.permissions.action, "read"),
          isNull(s.permissions.condition),
          tenantId ? eq(s.roles.tenantId, tenantId) : undefined,
        ),
      );
    const seen = new Set<string>();
    for (const row of publicReads as { collection: string }[]) {
      if (seen.has(row.collection)) continue;
      seen.add(row.collection);
      out.push({
        id: `sec-public-read-${row.collection}`,
        kind: "security",
        level: "error",
        rule: "public-read",
        groupTitle: "Public reads with no condition",
        title: `Public read on ${row.collection} with no condition`,
        body: `The 'public' role can read ${row.collection} with no DSL condition — anonymous traffic can list every row, including any sensitive fields.`,
        fix: `Remove the public read permission on ${row.collection}, or scope it with a condition such as { is_public: { _eq: true } }.`,
        resource: `permissions · ${row.collection}`,
        link: `/collections/${row.collection}`,
      });
    }
  } catch {
    // permissions table not migrated yet — skip this check silently.
  }

  // Public write permission: the `public` role with a create/update/delete
  // action — anonymous traffic can mutate data.
  try {
    const publicWrites = (await db
      .select({
        collection: s.permissions.collection,
        action: s.permissions.action,
      })
      .from(s.permissions)
      .innerJoin(s.roles, eq(s.permissions.roleId, s.roles.id))
      .where(
        and(
          eq(s.roles.name, "public"),
          tenantId ? eq(s.roles.tenantId, tenantId) : undefined,
        ),
      )) as { collection: string; action: string }[];
    for (const row of publicWrites) {
      if (!["create", "update", "delete"].includes(row.action)) continue;
      out.push({
        id: `sec-public-write-${row.collection}-${row.action}`,
        kind: "security",
        level: "error",
        rule: "public-write",
        groupTitle: "Public write permissions",
        title: `Public ${row.action} on ${row.collection}`,
        body: `The 'public' role can ${row.action} rows on ${row.collection} — anonymous, unauthenticated traffic can mutate this collection.`,
        fix: `Remove the public ${row.action} permission on ${row.collection}. Writes should require the 'authenticated' role at minimum.`,
        resource: `permissions · ${row.collection}`,
        link: `/collections/${row.collection}`,
      });
    }
  } catch {
    // permissions / roles table not migrated — skip.
  }

  // Owner-scoped collection missing an `authenticated` update condition:
  // ownerScoped sugar is meant to scope writes to the row owner. If the
  // update permission for `authenticated` has a null condition, any signed-in
  // user can edit any row.
  try {
    const collRows = (await db
      .select({
        slug: s.collections.slug,
        ownerScoped: s.collections.ownerScoped,
      })
      .from(s.collections)
      .where(
        tenantId ? eq(s.collections.tenantId, tenantId) : undefined,
      )) as { slug: string; ownerScoped: boolean }[];

    const ownerScoped = collRows.filter((r) => r.ownerScoped);
    if (ownerScoped.length > 0) {
      const updatePerms = (await db
        .select({
          collection: s.permissions.collection,
          condition: s.permissions.condition,
        })
        .from(s.permissions)
        .innerJoin(s.roles, eq(s.permissions.roleId, s.roles.id))
        .where(
          and(
            eq(s.roles.name, "authenticated"),
            eq(s.permissions.action, "update"),
            tenantId ? eq(s.roles.tenantId, tenantId) : undefined,
          ),
        )) as { collection: string; condition: unknown }[];

      for (const coll of ownerScoped) {
        const perms = updatePerms.filter((p) => p.collection === coll.slug);
        const hasGuardedUpdate = perms.some((p) => p.condition != null);
        if (!hasGuardedUpdate) {
          const missingEntirely = perms.length === 0;
          out.push({
            id: `sec-owner-scope-${coll.slug}`,
            kind: "security",
            level: "error",
            rule: "owner-scope",
            groupTitle: "Owner-scoped collections with unguarded updates",
            title: `Owner-scoped collection ${coll.slug} has an unguarded update permission`,
            body: missingEntirely
              ? `${coll.slug} is owner-scoped but has no 'authenticated' update permission row — wiring may be incomplete.`
              : `${coll.slug} is owner-scoped but its 'authenticated' update permission has no DSL condition — any signed-in user can edit any row.`,
            fix: `Add { owner_id: { _eq: "$user.id" } } to the authenticated update permission on ${coll.slug}.`,
            resource: `permissions · ${coll.slug}`,
            link: `/collections/${coll.slug}`,
          });
        }
      }
    }
  } catch {
    // collections / permissions table not migrated — skip.
  }

  // API key without a role scope: a key with role_id = null inherits the
  // owner's full role set (potentially admin).
  try {
    const keyRows = (await db
      .select({
        id: s.apiKeys.id,
        prefix: s.apiKeys.prefix,
        name: s.apiKeys.name,
        roleId: s.apiKeys.roleId,
        revokedAt: s.apiKeys.revokedAt,
        expiresAt: s.apiKeys.expiresAt,
      })
      .from(s.apiKeys)
      .where(
        tenantId ? eq(s.apiKeys.tenantId, tenantId) : undefined,
      )) as {
      id: string;
      prefix: string;
      name: string;
      roleId: string | null;
      revokedAt: Date | number | null;
      expiresAt: Date | number | null;
    }[];

    const nowMs = Date.now();
    const toMs = (v: Date | number | null): number | null =>
      v == null ? null : v instanceof Date ? v.getTime() : Number(v);

    for (const key of keyRows) {
      const exp = toMs(key.expiresAt);
      const expired = exp != null && exp <= nowMs;

      // No role scope — active, non-expired key inheriting the owner's roles.
      if (!key.roleId && key.revokedAt == null && !expired) {
        out.push({
          id: `sec-apikey-noscope-${key.id}`,
          kind: "security",
          level: "warn",
          rule: "apikey-noscope",
          groupTitle: "API keys with no role scope",
          title: `API key "${key.name}" has no role scope`,
          body: `${key.prefix} inherits its owner's full role set — including admin if the owner is an admin.`,
          fix: `Bind the key to a narrower role via role_id, or rotate it to a service account that only holds the roles it needs.`,
          resource: `api_keys · ${key.prefix}`,
          link: "/api-keys",
        });
      }

      // Expired but not revoked — harmless (lookup rejects it) but stale.
      if (expired && key.revokedAt == null) {
        out.push({
          id: `sec-apikey-expired-${key.id}`,
          kind: "security",
          level: "info",
          rule: "apikey-expired",
          groupTitle: "Expired API keys not yet revoked",
          title: `API key "${key.name}" is expired but not revoked`,
          body: `${key.prefix} passed its expiry date — auth lookup already rejects it, but the row lingers. Revoking it keeps the key list honest.`,
          fix: `Revoke ${key.prefix} so it drops off the active key list.`,
          resource: `api_keys · ${key.prefix}`,
          link: "/api-keys",
        });
      }
    }
  } catch {
    // api_keys table not migrated — skip.
  }

  // ── Console transports: the three ways a message can be "sent" nowhere ──
  //
  // Each of email / SMS / push falls back to a console adapter that logs the
  // message and reports success. The SMS and push ones are the sharper edge:
  // `{ sent: recipients.length, failed: 0 }` is indistinguishable, to every
  // caller and every metric, from a delivery that actually happened. So a
  // workspace can run a whole notification feature, watch it report 100%
  // delivery, and have sent nothing.
  //
  // **All three skip on managed cloud, and that is a correctness fix, not a
  // courtesy.** `buildContext` swaps in the control-plane gateway whenever the
  // resolved spec is `console` and `cloudConfigured(env)` — so on a managed
  // project the console adapter is never the one that runs, and the finding
  // would be describing a fallback that cannot happen. Note this is a DIFFERENT
  // judgement from `sec-backups-off` below: there, being a cloud tenant does not
  // mean the platform takes backups (a plan can exclude them, hence
  // `CLOUD_MANAGED_BACKUPS`), whereas here the swap is unconditional in the
  // code path. Ask what the platform actually does, not who the tenant is.
  const managedTransports = cloudConfigured(ctx.env);

  try {
    const row = await loadEmailConfigRow(ctx, tenantId);
    if (!row && !envHasRealEmailProvider(ctx.env) && !managedTransports) {
      out.push({
        id: "sec-email-console-fallback",
        kind: "security",
        level: "info",
        rule: "email-console-fallback",
        groupTitle: "Email transport falls back to the console",
        title: "Email provider falls back to the console adapter",
        body: "No workspace email_config and no deployment EMAIL_PROVIDER credentials are set — verification, reset, and invite mail is logged to stdout instead of being delivered.",
        fix: "Configure Resend, SendGrid, Mailgun, or SES under Settings → Email (or set EMAIL_PROVIDER + EMAIL_FROM in the deployment env).",
        resource: "email_config · provider",
        link: "/settings",
      });
    }
  } catch {
    // email_config read failed — skip.
  }

  // SMS. `warn`, not `info` like email: an undelivered verification mail is
  // usually noticed by the person waiting for it, whereas the SMS adapter's
  // answer actively asserts the opposite — a caller reading `{sent: 3,
  // failed: 0}` has been told the messages went, and nothing downstream will
  // ever correct that.
  try {
    const row = await loadSmsConfigRow(ctx, tenantId);
    if (!row && selectSmsSpec(ctx.env).provider === "console" && !managedTransports) {
      out.push({
        id: "sec-sms-console-fallback",
        kind: "security",
        level: "warn",
        rule: "sms-console-fallback",
        groupTitle: "SMS transport falls back to the console",
        title: "SMS provider falls back to the console adapter",
        body: "No workspace sms_config and no deployment SMS credentials are set, so messages are logged to stdout. The console adapter reports every recipient as sent and none as failed, so a send looks successful in the API response, the activity log and the usage counters alike — there is nothing to notice.",
        fix: "Configure Twilio, Amazon SNS, Netgsm or İletimerkezi under Settings → SMS (or set the matching credentials in the deployment env).",
        resource: "sms_config · provider",
        link: "/settings",
      });
    }
  } catch {
    // sms_config read failed — skip.
  }

  // Push. Same shape, same reasoning; the console adapter answers
  // `{ sent: tokens.length, failed: 0, invalidTokens: [] }`.
  try {
    const row = await loadPushConfigRow(ctx, tenantId);
    if (!row && selectPushSpec(ctx.env).provider === "console" && !managedTransports) {
      out.push({
        id: "sec-push-console-fallback",
        kind: "security",
        level: "warn",
        rule: "push-console-fallback",
        groupTitle: "Push transport falls back to the console",
        title: "Push provider falls back to the console adapter",
        body: "No workspace push_config and no deployment FCM / APNs / Web Push credentials are set, so notifications are logged to stdout. The console adapter reports every token as sent and none as failed, and returns no invalid tokens — so a device that would have been pruned stays on the list too.",
        fix: "Configure FCM, APNs or Web Push under Settings → Push (or set the matching credentials in the deployment env).",
        resource: "push_config · provider",
        link: "/settings",
      });
    }
  } catch {
    // push_config read failed — skip.
  }

  // No automatic backups. Scheduling defaults to `off` and nothing ever
  // mentions it, so the common case is a workspace running for months with no
  // recoverable copy of anything — which is also what every other recovery path
  // in the product quietly assumes exists. `warn`, not `info`: unlike a console
  // email fallback, you do not find out this was wrong until you need it.
  //
  // Filed under `kind: "security"` rather than a new `"resilience"` kind on
  // purpose — widening AdvisorKind for one rule would mean touching the advisor
  // UI's grouping and its surfaces test for no gain to the reader.
  //
  // Skipped when the control plane is taking backups for this instance. There
  // the instance-side schedule is expected to stay `off`, so the rule would warn
  // that workspace forever about a gap that does not exist.
  //
  // Keyed on CLOUD_MANAGED_BACKUPS, NOT on "is this a cloud tenant": managed
  // plans without backups exist, and a tenant on one has no backups at either
  // layer. For them this warning is the only thing that would say so, and it
  // must keep firing.
  try {
    const cfg = await loadBackupConfig(ctx, tenantId);
    if (cfg.schedule === "off" && ctx.env.CLOUD_MANAGED_BACKUPS !== "true") {
      out.push({
        id: "sec-backups-off",
        kind: "security",
        level: "warn",
        rule: "backups-off",
        groupTitle: "Automatic backups are off",
        title: "No automatic backups are scheduled",
        body: "Scheduled backups are disabled for this workspace, so there is no periodic copy of its data. Restore, and the pre-drop safety copies taken before a destructive schema change, can only recover as far back as a backup that exists.",
        fix: "Turn on a daily or weekly schedule under Database → Backups, and set a retention that matches how far back you would want to go.",
        resource: "app_settings · backupConfig",
        link: "/database",
      });
    }
  } catch {
    // backup config read failed — skip.
  }

  // Half-configured OAuth provider: exactly one of id / secret set for a
  // provider — better-auth silently won't wire it up.
  try {
    const oauthPairs: [string, string | undefined, string | undefined][] = [
      ["Google", ctx.env.OAUTH_GOOGLE_CLIENT_ID, ctx.env.OAUTH_GOOGLE_CLIENT_SECRET],
      ["GitHub", ctx.env.OAUTH_GITHUB_CLIENT_ID, ctx.env.OAUTH_GITHUB_CLIENT_SECRET],
    ];
    for (const [name, id, secret] of oauthPairs) {
      const hasId = Boolean(id?.trim());
      const hasSecret = Boolean(secret?.trim());
      if (hasId !== hasSecret) {
        out.push({
          id: `sec-oauth-incomplete-${name.toLowerCase()}`,
          kind: "security",
          level: "warn",
          rule: "oauth-incomplete",
          groupTitle: "Half-configured OAuth providers",
          title: `${name} OAuth is half-configured`,
          body: `Only the ${hasId ? "client ID" : "client secret"} is set for ${name} — better-auth needs both id and secret, so this provider will silently not wire up.`,
          fix: `Set both OAUTH_${name.toUpperCase()}_CLIENT_ID and OAUTH_${name.toUpperCase()}_CLIENT_SECRET in the deployment env, or unset the one that is configured.`,
          resource: `env · OAUTH_${name.toUpperCase()}_*`,
          link: "/authentication",
        });
      }
    }
  } catch {
    // env read failed — skip.
  }

  // No admin user: a workspace with zero admins can lock itself out of
  // every admin-only surface.
  try {
    const adminRows = (await db
      .select({ userId: s.userRoles.userId })
      .from(s.userRoles)
      .innerJoin(s.roles, eq(s.userRoles.roleId, s.roles.id))
      .where(
        and(
          eq(s.roles.name, "admin"),
          tenantId ? eq(s.roles.tenantId, tenantId) : undefined,
        ),
      )) as { userId: string }[];
    if (adminRows.length === 0) {
      out.push({
        id: "sec-no-admin",
        kind: "security",
        level: "warn",
        rule: "no-admin",
        groupTitle: "Workspace has no admin",
        title: "No user holds the admin role",
        body: "No account is assigned the 'admin' role — admin-only surfaces (settings, roles, the database console) have no operator.",
        fix: "Grant the admin role to a trusted account via Users → Roles.",
        resource: "user_roles · admin",
        link: "/users",
      });
    }
  } catch {
    // user_roles / roles table not migrated — skip.
  }

  // Image transforms are silently not happening.
  //
  // `passthroughImage` is the last link of `bunImage() ?? sharpImage() ??
  // wasmImage() ?? passthroughImage()`, and it returns the source body
  // untouched. It is a legitimate choice — a runtime with no image API has to
  // serve SOMETHING — but it is indistinguishable from a working transform
  // from the outside: `?w=200` answers 200 OK with the original bytes, so a
  // thumbnail grid quietly downloads full-size originals and only the bill
  // says so.
  //
  // Skipped when an edge backend exists (`ctx.edgeImage`): Cloudflare and
  // Netlify resize at the CDN and never reach the in-process adapter, so a
  // `passthrough` there costs nothing. Skipped too when the caller gave no
  // `image` at all — a rule that cannot tell should say nothing rather than
  // guess.
  //
  // Filed under `performance`, not `security`: nothing is exposed, an image is
  // simply many times larger than it was asked to be.
  if (ctx.image?.name === "passthrough" && !ctx.edgeImage) {
    out.push({
      id: "perf-image-passthrough",
      kind: "performance",
      level: "warn",
      rule: "image-passthrough",
      groupTitle: "Image transforms are not being applied",
      title: "The image adapter passes the original bytes through",
      body: "No in-process image transformer loaded (Bun's image API, sharp, or the wasm fallback) and this runtime has no edge resize backend, so `?w=`/`?h=`/`?fit=` are accepted and ignored. Every request answers 200 with the full-size original, which looks correct in the browser and is not.",
      fix: "Run on Bun (its built-in image API needs nothing installed), install sharp on a Node host, or deploy behind Cloudflare Images / the Netlify Image CDN, which resize at the edge.",
      resource: "image · passthrough",
      link: "/storage",
    });
  }

  // --- PERFORMANCE (runtime, traffic-derived) ----------------------------
  //
  // Aggregate the spans the request middleware already writes and let what
  // actually happened drive the advice. Every finding below quotes its observed
  // numbers; when the window holds no spans, none of them fire at all.
  const insights =
    opts.insights ??
    (await loadRuntimeInsights(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      tenantId,
      { days: windowDays, limit: 200 },
    ).catch(() => null));

  // (table, column) pairs a traffic-derived index finding already covers. The
  // static rules below skip these so one missing index is one finding — the
  // measured version, not the inferred one.
  const coveredIndexPairs = new Set<string>();
  const sampleNote =
    insights && insights.window.sampleRate < 1
      ? ` Spans are sampled at ${pct(insights.window.sampleRate)} (TRACES_SAMPLE_RATE), so the counts describe a sample of real traffic.`
      : "";

  if (insights && insights.window.spanCount > 0) {
    // Slow endpoints — p95 over the threshold with enough traffic to mean it.
    try {
      const slow = insights.endpoints
        .filter(
          (e) =>
            e.requests >= RUNTIME.minRequests && e.p95 >= RUNTIME.slowP95Ms,
        )
        .slice(0, RUNTIME.maxFindingsPerRule);
      for (const e of slow) {
        const collection = collectionFromPath(e.path);
        out.push({
          id: `perf-slow-endpoint-${e.method}-${e.path}`,
          kind: "performance",
          level: e.p95 >= RUNTIME.verySlowP95Ms ? "error" : "warn",
          rule: "slow-endpoint",
          groupTitle: "Slow endpoints",
          title: `${e.route} p95 is ${e.p95} ms`,
          body: `Over the last ${windowDays} day(s), ${e.requests} recorded request(s) to ${e.route} had a p95 of ${e.p95} ms (p50 ${e.p50} ms, p99 ${e.p99} ms, max ${e.maxMs} ms).${sampleNote}`,
          fix: collection
            ? `Open the Traces panel filtered to ${e.path} to find the slow calls, then check the Insights tab for which columns ${collection} filters on and whether they are indexed.`
            : `Open the Traces panel filtered to ${e.path} to inspect the slow calls span by span.`,
          resource: `endpoint · ${e.route}`,
          link: "/traces",
          evidence: { requests: e.requests, windowDays, p95: e.p95 },
        });
      }
    } catch {
      // Aggregation shape unexpected — skip rather than emit a bad finding.
    }

    // Endpoints returning server errors.
    try {
      const failing = insights.endpoints
        .filter(
          (e) =>
            e.requests >= RUNTIME.minErrorRequests &&
            e.errorRate >= RUNTIME.errorRate,
        )
        .sort((a, b) => b.errorRate - a.errorRate)
        .slice(0, RUNTIME.maxFindingsPerRule);
      for (const e of failing) {
        out.push({
          id: `perf-endpoint-errors-${e.method}-${e.path}`,
          kind: "performance",
          level: "error",
          rule: "endpoint-errors",
          groupTitle: "Endpoints returning server errors",
          title: `${e.route} returned 5xx on ${pct(e.errorRate)} of requests`,
          body: `${e.serverErrors} of ${e.requests} recorded request(s) to ${e.route} in the last ${windowDays} day(s) returned a 5xx.${sampleNote}`,
          fix: `Filter the Traces panel to ${e.path} with a minimum status of 500 — each failing span carries the error code the handler raised.`,
          resource: `endpoint · ${e.route}`,
          link: "/traces",
          evidence: {
            requests: e.requests,
            windowDays,
            errorRate: e.errorRate,
          },
        });
      }
    } catch {
      // Skip silently.
    }

    // Traffic-derived missing indexes: columns real list traffic filters or
    // sorts on that have no covering index on the physical table.
    try {
      const collRows = (await db
        .select({
          slug: s.collections.slug,
          physicalTable: s.collections.physicalTable,
          status: s.collections.status,
        })
        .from(s.collections)
        .where(
          tenantId ? eq(s.collections.tenantId, tenantId) : undefined,
        )) as { slug: string; physicalTable: string; status: string }[];
      const tableBySlug = new Map(
        collRows
          .filter((r) => r.status !== "archived")
          .map((r) => [r.slug, r.physicalTable] as const),
      );

      let filterFindings = 0;
      let sortFindings = 0;
      for (const stat of insights.collections) {
        if (stat.listRequests < RUNTIME.minRequests) continue;
        const table = tableBySlug.get(stat.collection);
        if (!table) continue;
        let indexes: string[][];
        let existing: Set<string>;
        try {
          indexes = await tableIndexes(db, ctx.dialect, table);
          existing = await tableColumns(db, ctx.dialect, table);
        } catch {
          continue;
        }

        const emit = (
          use: { column: string; requests: number; share: number },
          kind: "filter" | "sort",
        ): boolean => {
          if (!existing.has(use.column)) return false;
          if (isColumnCovered(indexes, use.column)) return false;
          const action = createIndexAction(table, [use.column]);
          if (!action) return false;
          // One index serves both filtering and sorting on the same column —
          // don't report the same gap twice.
          const pair = `${table}.${use.column}`;
          if (coveredIndexPairs.has(pair)) return false;
          coveredIndexPairs.add(pair);
          out.push({
            id: `perf-hot-${kind}-index-${stat.collection}-${use.column}`,
            kind: "performance",
            level: "warn",
            rule: kind === "filter" ? "hot-filter-index" : "hot-sort-index",
            groupTitle:
              kind === "filter"
                ? "Frequently filtered columns with no index"
                : "Frequently sorted columns with no index",
            title: `${stat.collection} ${kind}s by ${use.column} on ${pct(use.share)} of list requests, with no index`,
            body: `${use.requests} of ${stat.listRequests} recorded list request(s) on ${stat.collection} in the last ${windowDays} day(s) ${kind === "filter" ? "filter by" : "sort by"} ${use.column}, but ${table} has no index leading with that column — each of those requests scans the table (list p95 is ${stat.p95} ms).${sampleNote}`,
            fix: `${action.sql};`,
            resource: `${table} · ${use.column}`,
            link: `/collections/${stat.collection}`,
            action,
            evidence: {
              requests: use.requests,
              windowDays,
              share: use.share,
              p95: stat.p95,
            },
          });
          return true;
        };

        for (const use of stat.filters) {
          if (filterFindings >= RUNTIME.maxFindingsPerRule) break;
          if (use.share < RUNTIME.filterShare) continue;
          if (use.requests < RUNTIME.minRequests) continue;
          if (emit(use, "filter")) filterFindings++;
        }
        for (const use of stat.sorts) {
          if (sortFindings >= RUNTIME.maxFindingsPerRule) break;
          if (use.share < RUNTIME.sortShare) continue;
          if (use.requests < RUNTIME.minRequests) continue;
          if (emit(use, "sort")) sortFindings++;
        }
      }
    } catch {
      // collections table not migrated — skip the traffic-derived index rules.
    }
  }

  // --- PERFORMANCE (static, schema-derived) ------------------------------
  //
  // Static, schema-derived index-presence checks. Each inspects the physical
  // table's index catalog and flags a missing index on a hot query path.
  // These reason about the schema alone, so they still fire on a workspace
  // with no recorded traffic; where runtime evidence already covered the same
  // (table, column) pair above, the measured finding wins and this one is
  // skipped. Wrapped in try/catch so an introspection failure on either
  // dialect skips the check rather than emitting an unbacked finding.
  try {
    const perfCollRows = (await db
      .select({
        slug: s.collections.slug,
        physicalTable: s.collections.physicalTable,
        ownerScoped: s.collections.ownerScoped,
        adopted: s.collections.adopted,
        ownerIdColumn: s.collections.ownerIdColumn,
        hasCreatedAt: s.collections.hasCreatedAt,
        createdAtColumn: s.collections.createdAtColumn,
        status: s.collections.status,
      })
      .from(s.collections)
      .where(
        tenantId ? eq(s.collections.tenantId, tenantId) : undefined,
      )) as {
      slug: string;
      physicalTable: string;
      ownerScoped: boolean;
      adopted: boolean;
      ownerIdColumn: string | null;
      hasCreatedAt: boolean;
      createdAtColumn: string | null;
      status: string;
    }[];

    for (const coll of perfCollRows) {
      if (coll.status === "archived") continue;
      let indexes: string[][];
      try {
        indexes = await tableIndexes(db, ctx.dialect, coll.physicalTable);
      } catch {
        // Index introspection failed for this table — skip it silently.
        continue;
      }

      // Owner-scoped reads filter by owner_id on every request.
      if (coll.ownerScoped) {
        const ownerCol = coll.ownerIdColumn ?? "owner_id";
        if (
          !isColumnCovered(indexes, ownerCol) &&
          !coveredIndexPairs.has(`${coll.physicalTable}.${ownerCol}`)
        ) {
          const action = createIndexAction(coll.physicalTable, [ownerCol]);
          out.push({
            id: `perf-owner-index-${coll.slug}`,
            kind: "performance",
            level: "warn",
            rule: "owner-index",
            groupTitle: "Owner-scoped collections missing an owner_id index",
            title: `${coll.slug} has no index on ${ownerCol}`,
            body: `${coll.slug} is owner-scoped — owner-scoped reads filter by ${ownerCol} on every request; an unindexed ${ownerCol} forces a full scan.`,
            fix: action
              ? `${action.sql};`
              : `CREATE INDEX ON ${coll.physicalTable} (${ownerCol}); — or add the index through your migration tooling.`,
            resource: `${coll.physicalTable} · ${ownerCol}`,
            link: `/collections/${coll.slug}`,
            ...(action ? { action } : {}),
          });
        }
      }

      // The items query API default-sorts `-created_at`.
      if (coll.hasCreatedAt) {
        const createdCol = coll.createdAtColumn ?? "created_at";
        if (
          !isColumnCovered(indexes, createdCol) &&
          !coveredIndexPairs.has(`${coll.physicalTable}.${createdCol}`)
        ) {
          const action = createIndexAction(coll.physicalTable, [createdCol]);
          out.push({
            id: `perf-created-index-${coll.slug}`,
            kind: "performance",
            level: "info",
            rule: "created-index",
            groupTitle: "Collections missing a created_at index",
            title: `${coll.slug} has no index covering ${createdCol}`,
            body: `The items query API default-sorts by -${createdCol}; without a covering index every list request sorts the full table.`,
            fix: action
              ? `${action.sql};`
              : `CREATE INDEX ON ${coll.physicalTable} (${createdCol}); — or add the index through your migration tooling.`,
            resource: `${coll.physicalTable} · ${createdCol}`,
            link: `/collections/${coll.slug}`,
            ...(action ? { action } : {}),
          });
        }
      }
    }
  } catch {
    // collections table not migrated — skip the whole performance section.
  }

  return {
    data: out,
    score: computeScore(out),
    generatedAt: new Date().toISOString(),
    runtime: {
      windowDays,
      spanCount: insights?.window.spanCount ?? 0,
      sampleRate: insights?.window.sampleRate ?? 1,
      truncated: insights?.window.truncated ?? false,
    },
  };
};

/**
 * Carry out the remediation a finding carries. The ONE implementation behind
 * REST `POST /api/admin/advisor/apply`, GraphQL `advisorApply`, the MCP
 * `advisor-apply` tool, and `backlex advisor --apply` — so the "re-derive the
 * statement, never trust the caller" rule can't be forgotten on one surface.
 *
 * The caller supplies only the finding **id**. The advisor is re-run here and
 * the statement executed is the one the fresh finding carries, which means a
 * fix can never be applied for a finding that no longer holds.
 */
export const applyAdvisorFix = async (
  ctx: AdvisorCtx,
  tenantId: string | null,
  input: {
    id: string;
    windowDays?: number;
    /** Recorded on the audit row so an applied index is attributable. */
    userId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ applied: AdvisorAction }> => {
  const result = await runAdvisorChecks(ctx, tenantId, {
    windowDays: input.windowDays,
  });
  const finding = result.data.find((f) => f.id === input.id);
  if (!finding)
    throw new AppError(
      "NOT_FOUND",
      "No current advisor finding with that id — re-run the advisor and try again.",
    );
  const action = finding.action;
  if (!action)
    throw new AppError(
      "VALIDATION",
      `Finding "${input.id}" has no automatic fix. Apply the suggested change manually.`,
    );

  try {
    const stmt = sql.raw(action.sql);
    if (ctx.dialect === "pg") await (ctx.db as any).execute(stmt);
    else await (ctx.db as any).run(stmt);
  } catch (e) {
    throw new AppError(
      "INTERNAL",
      `Could not create the index: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  await recordActivity(
    { db: ctx.db as any, dialect: ctx.dialect },
    {
      userId: input.userId ?? null,
      tenantId,
      action: "advisor.apply",
      collection: action.table,
      itemId: action.indexName,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      payload: { findingId: input.id, rule: finding.rule, sql: action.sql },
    },
  );

  return { applied: action };
};
