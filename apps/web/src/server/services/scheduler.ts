import { eq, lte } from "drizzle-orm";
import cronParser from "cron-parser";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AuthSubject } from "@backlex/core";
import { runFunction } from "./sandbox";
import { buildContext } from "../context";
import type { Env } from "../env";
import type { FunctionRow } from "./functions";
import { listCronFlows, runFlowById, resumeContinuation } from "./flows";

// cron-parser is CJS — importing the named `parseExpression` directly breaks on
// Deno's stricter CJS interop, so reach it via the default (`module.exports`),
// which holds on Node / Bun / Deno alike.
type CronDate = { toDate(): Date };
const parseExpression = (
  cronParser as unknown as {
    parseExpression: (
      expr: string,
      opts?: { currentDate?: Date },
    ) => { next(): CronDate; prev(): CronDate };
  }
).parseExpression;
import { pruneScheduleFires, runDueScheduleFlows } from "./flow-schedules";
import { runKpiAlerts } from "./kpi-alerts";
import { claimDueTasks, deleteTask } from "./scheduled-tasks";
import { expireDueRequests, expireRequest } from "./approvals";
import { enqueueJob, processJobs } from "./jobs";
import { enqueueDueSyncs } from "./integration-syncs";
import { sweepExpiredUploads } from "./uploads";
import { sweepStaleFormUploads } from "./form-uploads";
import { sweepStaleFormDrafts } from "./form-drafts";
import { publishDueItems, unpublishDueItems } from "./items/scheduled-publish";
import { listConnectedProviders } from "./payments";
import { pruneOldActivity, pruneOldActivityByPrefix } from "./activity";
import { pruneOldSpans } from "./traces";
import { pruneAnalyticsEvents, pruneErrorEvents } from "./analytics";
import { pruneBroadcastMessages } from "./broadcast";
import { maybeRunScheduledBackups } from "./backup";
import { runScheduledSnapshots } from "./schema-versions";
import { processMigrationRuns } from "./migrate";
import { processCdcSinks } from "./cdc";
import { flushUsage, sweepUsageGauges } from "./usage";
import { invokeExtensionHook, listCronExtensionHooks } from "./extensions";
import { isDemoMode, maybeResetDemo } from "./demo";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.functions : sqlite.schema.functions;

const SYSTEM_AUTH: AuthSubject = { userId: null, email: null, roles: [] };

/**
 * Per-process tick state. `lastTickAt` is the wall-clock time we last
 * scanned for due crons; the next tick fires every cron whose pattern's
 * `prev()` falls inside `(lastTickAt, now]`. This collapses missed
 * minutes (after a restart or pause) into at most one execution per
 * pattern per missed window — i.e. backlex guarantees at-most-once
 * dispatch per minute, never doubles.
 */
let lastTickAt: Date | null = null;

/** Pruning is throttled to once every 24h so the cron tick stays cheap; a scan
 *  + DELETE on a growing table is overkill on a per-minute schedule. */
const ACTIVITY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Throttled so the per-minute tick stays cheap — the sweep itself re-checks
 *  each workspace's schedule interval, so a coarse 15-minute cadence never
 *  misses a daily or weekly window. */
const BACKUP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** Webhooks carry the steady state, so the reconcile pull only has to catch
 *  drift and missed deliveries — six-hourly is plenty and keeps the provider
 *  API-rate budget untouched for the workspace's own calls. */
const PAYMENTS_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEMO_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Scheduled schema snapshots (#9) — throttled like backups; the sweep itself
// re-checks each workspace's daily/weekly interval so this only bounds cost.
const SCHEMA_SNAPSHOT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// Usage gauge sweep (#12) — per-workspace SUM/COUNT measurements; a coarse
// half-hourly cadence is plenty for "how big is this workspace" gauges.
const USAGE_GAUGE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Durable, cross-instance throttle for the periodic sweeps below.
 *
 * These used to be plain module-level `let lastXSweepAt = 0` counters. That
 * only works behind a long-lived process (`startBunScheduler`, Deno). Every
 * serverless entry — the Workers `scheduled()` handler, Vercel, Netlify,
 * Lambda, GCP, Azure — may run each minute's tick in a FRESH instance, where
 * the counter is back at `0` and `now - 0 >= interval` is trivially true. So
 * on those runtimes none of the throttles engaged: the 24h activity prune, the
 * 15-minute backup and schema-snapshot sweeps and the 30-minute usage-gauge
 * sweep all ran on EVERY minute-ly tick, up to 1440× the intended DB work.
 *
 * The watermark now lives in `app_settings`, claimed with an atomic
 * compare-and-set: the conditional `ON CONFLICT … DO UPDATE … WHERE
 * updated_at <= cutoff` means exactly one instance can win a given window, so
 * concurrent ticks don't double-run either. We key on the PRIMARY KEY rather
 * than the `(tenant_id, key)` unique index because these rows are global
 * (`tenant_id IS NULL`) and both dialects treat NULLs in a unique index as
 * distinct — an `ON CONFLICT (tenant_id, key)` target would never match and
 * would insert a new row every tick.
 */
const claimSweep = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  name: string,
  intervalMs: number,
  now: Date,
): Promise<boolean> => {
  const t =
    ctx.dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;
  const id = `__sweep__${name}`;
  const cutoff = new Date(now.getTime() - intervalMs);
  try {
    const rows = (await (ctx.db as any)
      .insert(t)
      .values({ id, tenantId: null, key: id, value: now.getTime(), updatedAt: now })
      .onConflictDoUpdate({
        target: t.id,
        set: { value: now.getTime(), updatedAt: now },
        setWhere: lte(t.updatedAt, cutoff),
      })
      .returning({ id: t.id })) as { id: string }[];
    // Rows returned → we won this window. Empty → another instance holds it,
    // or the interval hasn't elapsed yet.
    return rows.length > 0;
  } catch (e) {
    // Never let a throttle-bookkeeping failure take the whole tick down. Fail
    // CLOSED (skip the sweep): the next tick retries a minute later, which is
    // far cheaper than falling back to running every expensive sweep always.
    console.error(`[sweep:${name}] claim failed`, e);
    return false;
  }
};
const DEFAULT_ACTIVITY_RETENTION_DAYS = 90;
const DEFAULT_TRACES_RETENTION_DAYS = 7;
// Sensitive-read audit rows (`access.*`) are opt-in but higher-volume, so they
// get a shorter default clock than the global retention.
const DEFAULT_ACCESS_AUDIT_RETENTION_DAYS = 30;
// Product analytics (#22). A quarter covers the reporting windows the admin UI
// offers (up to 365d is allowed, but the aggregates people actually read are
// 7/30/90) while keeping the highest-volume table bounded.
const DEFAULT_ANALYTICS_RETENTION_DAYS = 90;
const DEFAULT_ERRORS_RETENTION_DAYS = 90;
// MCP audit rows (`mcp.*`) — one per agent tool call, so chattier than the
// mutation log they sit next to. Same shorter clock as the read audit.
const DEFAULT_MCP_AUDIT_RETENTION_DAYS = 30;

const dueCronFunctions = (
  fns: FunctionRow[],
  prev: Date,
  now: Date,
): FunctionRow[] => {
  const due: FunctionRow[] = [];
  for (const fn of fns) {
    if (!fn.active || !fn.pattern) continue;
    try {
      const interval = parseExpression(fn.pattern, { currentDate: now });
      const prevFire = interval.prev().toDate();
      if (prevFire > prev && prevFire <= now) {
        due.push(fn);
      }
    } catch (e) {
      console.error(`[cron] bad pattern for ${fn.name}: ${(e as Error).message}`);
    }
  }
  return due;
};

export const cronTick = async (env: Env, now: Date = new Date()): Promise<void> => {
  const prev = lastTickAt ?? new Date(now.getTime() - 60_000);
  lastTickAt = now;

  const ctx = await buildContext(env);
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.trigger, "cron"))) as FunctionRow[];

  const due = dueCronFunctions(rows, prev, now);

  await Promise.all(
    due.map(async (fn) => {
      try {
        // Cron rows live in `functions` across every workspace, so each
        // invocation has to carry its own row's tenantId — otherwise the
        // function's ctx.db calls would either land in the wrong workspace
        // or no workspace at all.
        const result = await runFunction(
          fn.code,
          { ctx, auth: { ...SYSTEM_AUTH, tenantId: fn.tenantId } },
          { firedAt: now.toISOString(), pattern: fn.pattern },
          fn.timeoutMs,
        );
        if (!result.ok) {
          console.error(`[cron:${fn.name}] error: ${result.error}`);
        } else if (result.logs.length > 0) {
          console.log(`[cron:${fn.name}] logs:\n${result.logs.join("\n")}`);
        }
      } catch (e) {
        console.error(`[cron:${fn.name}] crashed`, e);
      }
    }),
  );

  // Cron-triggered extension hooks: same prev/now window, each invocation
  // carries its own extension row's tenantId (rows span every workspace).
  const cronHooks = await listCronExtensionHooks(ctx);
  const dueHooks = cronHooks.filter(({ row, hook }) => {
    if (!hook.pattern) return false;
    try {
      const interval = parseExpression(hook.pattern, { currentDate: now });
      const prevFire = interval.prev().toDate();
      return prevFire > prev && prevFire <= now;
    } catch (e) {
      console.error(
        `[cron] bad pattern for ext ${row.name}:${hook.id}: ${(e as Error).message}`,
      );
      return false;
    }
  });
  await Promise.all(
    dueHooks.map(async ({ row, hook }) => {
      try {
        const result = await invokeExtensionHook(
          ctx,
          row,
          hook.id,
          { ...SYSTEM_AUTH, tenantId: row.tenantId },
          { firedAt: now.toISOString(), pattern: hook.pattern },
        );
        if (!result.ok) {
          console.error(`[cron:ext:${row.name}:${hook.id}] error: ${result.error}`);
        } else if (result.logs.length > 0) {
          console.log(
            `[cron:ext:${row.name}:${hook.id}] logs:\n${result.logs.join("\n")}`,
          );
        }
      } catch (e) {
        console.error(`[cron:ext:${row.name}:${hook.id}] crashed`, e);
      }
    }),
  );

  // Cron-triggered flows: same prev/now window logic, but the flow's `trigger`
  // column carries `cron:<5-field>` directly (no separate pattern column).
  const cronFlows = await listCronFlows(ctx);
  const dueFlows = cronFlows.filter((f) => {
    try {
      const interval = parseExpression(f.pattern, { currentDate: now });
      const prevFire = interval.prev().toDate();
      return prevFire > prev && prevFire <= now;
    } catch (e) {
      console.error(`[cron-flow] bad pattern for ${f.name}: ${(e as Error).message}`);
      return false;
    }
  });

  await Promise.all(
    dueFlows.map(async (f) => {
      try {
        await runFlowById(
          ctx,
          f.id,
          { firedAt: now.toISOString(), pattern: f.pattern },
          SYSTEM_AUTH,
        );
      } catch (e) {
        console.error(`[cron-flow:${f.name}] crashed`, e);
      }
    }),
  );

  // Date-relative flows: scan each schedule's collection and dispatch the rows
  // whose instant has arrived. Unlike the cron path above, this does NOT rely
  // on the prev/now window — `lastTickAt` is per-process and null on every cold
  // serverless tick, so a reminder would vanish into any gap. The scan reaches
  // back over its own catch-up window and leans on the fire ledger's unique
  // index for exactly-once instead.
  try {
    await runDueScheduleFlows(ctx, now);
  } catch (e) {
    console.error("[schedule-flow] tick failed", e);
  }

  // Watched KPIs: notify on the edge INTO a breach. Cheap when nothing is
  // watched (one indexed read returning no rows) and never throws, so a broken
  // definition can't stop the rest of the tick.
  try {
    await runKpiAlerts(ctx, now);
  } catch (e) {
    console.error("[kpi-alert] tick failed", e);
  }

  // Resume any flow continuations whose run_at has passed. claimDueTasks
  // marks rows as claimed atomically (PG via RETURNING, SQLite via the
  // single-process serial tick) so we never run a task twice within one
  // process — and across processes the claim window stops doubles too.
  let claimed: Awaited<ReturnType<typeof claimDueTasks>>;
  try {
    claimed = await claimDueTasks(ctx);
  } catch (e) {
    console.error("[scheduled-tasks] claim failed", e);
    return;
  }
  await Promise.all(
    claimed.map(async (task) => {
      try {
        if (task.payload?.kind === "approval-timeout") {
          // Nobody answered in time. `expireRequest` goes through the same
          // one-shot settle guard a decision does, so a person deciding in
          // this exact second still wins cleanly — one of the two transitions
          // finds the row already out of `pending` and does nothing.
          await expireRequest(ctx, task.payload.requestId);
          await deleteTask(ctx, task.id);
          return;
        }
        if (task.payload?.kind !== "flow-continuation") {
          // Unknown payload kind — drop the row so it doesn't keep getting
          // claimed forever.
          await deleteTask(ctx, task.id);
          return;
        }
        const result = await resumeContinuation(ctx, task.payload);
        if (!result.ok) {
          // runFlowOps reports op failures as {ok:false} instead of throwing —
          // leave the row claimed (it won't be re-claimed) so a human can
          // inspect / re-queue manually; deleting here would silently discard
          // the continuation.
          console.error(
            `[scheduled-task:${task.id}] resume failed: ${result.error}`,
          );
          return;
        }
        await deleteTask(ctx, task.id);
      } catch (e) {
        console.error(`[scheduled-task:${task.id}] resume failed`, e);
        // Leave the row claimed so a human can inspect / re-queue manually.
      }
    }),
  );

  // Source integrations: enqueue a pull for every sync whose interval has
  // elapsed. Enqueued rather than run inline so a slow provider cannot stall
  // the tick, and so a failing pull inherits the queue's retry + backoff.
  // Deliberately runs BEFORE processJobs so a due sync starts this tick rather
  // than waiting for the next one.
  try {
    await enqueueDueSyncs(ctx);
  } catch (e) {
    console.error("[integration-sync] enqueue failed", e);
  }

  // Durable job queue: claim + run a batch of due jobs (function handlers,
  // webhook deliveries with retry/dead-letter). Reuses the ctx built above so
  // we don't re-assemble adapters per tick.
  try {
    await processJobs(ctx);
  } catch (e) {
    console.error("[jobs] tick failed", e);
  }

  // Resumable uploads: abort + clean up sessions abandoned past their TTL so
  // the object store doesn't accumulate dangling multipart uploads.
  try {
    await sweepExpiredUploads(ctx);
  } catch (e) {
    console.error("[uploads] sweep failed", e);
  }

  // Public-form file uploads that were never submitted: delete the pending
  // objects + rows once they go stale so anonymous uploads can't accumulate.
  try {
    await sweepStaleFormUploads(ctx);
  } catch (e) {
    console.error("[form-uploads] sweep failed", e);
  }

  // Half-filled forms nobody came back to: delete them once they go stale, so
  // an anonymous write path doesn't hold personal answers indefinitely.
  try {
    await sweepStaleFormDrafts(ctx);
  } catch (e) {
    console.error("[form-drafts] sweep failed", e);
  }

  // Scheduled publishing: flip versioned-collection drafts whose `_publish_at`
  // has passed to `published`.
  try {
    await publishDueItems(ctx);
  } catch (e) {
    console.error("[scheduled-publish] tick failed", e);
  }

  // Scheduled unpublish (expiry): revert versioned-collection published rows
  // whose `_unpublish_at` has passed back to `draft`.
  try {
    await unpublishDueItems(ctx);
  } catch (e) {
    console.error("[scheduled-unpublish] tick failed", e);
  }

  // Approvals safety net. Each request enqueues its OWN timeout task, so this
  // normally finds nothing; it exists for the request whose enqueue failed, or
  // whose task row was lost to a restore. Settling twice is impossible — both
  // paths go through the same one-shot guard — so an overlap is harmless.
  try {
    await expireDueRequests(ctx);
  } catch (e) {
    console.error("[approvals] expiry sweep failed", e);
  }

  // Playground (demo) mode: wipe + reseed the workspace when the persisted
  // last-reset timestamp is older than the interval. The sweep claim only
  // bounds how often we *read* that timestamp; maybeResetDemo itself decides
  // whether a reset is actually due (and bootstraps a fresh demo instance on
  // the very first tick).
  if (
    isDemoMode(env) &&
    (await claimSweep(ctx, "demo", DEMO_SWEEP_INTERVAL_MS, now))
  ) {
    try {
      await maybeResetDemo(ctx, env, now);
    } catch (e) {
      console.error("[demo-reset] sweep failed", e);
    }
  }

  // Scheduled backups: run + prune per workspace, throttled so the per-minute
  // tick stays cheap (the sweep re-checks each schedule's interval itself).
  if (await claimSweep(ctx, "backup", BACKUP_SWEEP_INTERVAL_MS, now)) {
    try {
      await maybeRunScheduledBackups(ctx, now);
    } catch (e) {
      console.error("[scheduled-backup] sweep failed", e);
    }
  }

  // Payments reconcile: one queued job per connected provider, so a slow or
  // rate-limited provider API can never stall the tick — the job queue owns
  // the retry/backoff. Each job resumes from its stored cursor.
  if (await claimSweep(ctx, "payments-reconcile", PAYMENTS_SWEEP_INTERVAL_MS, now)) {
    try {
      const providers = await listConnectedProviders(ctx);
      for (const p of providers) {
        await enqueueJob(ctx, {
          type: "payments.reconcile",
          tenantId: p.tenantId,
          payload: { providerId: p.id, resume: true },
        });
      }
    } catch (e) {
      console.error("[payments-reconcile] sweep failed", e);
    }
  }

  // Scheduled schema snapshots: capture a `kind:"scheduled"` snapshot per
  // workspace whose cadence is due, then prune to keepLast. Same throttle +
  // interval-recheck posture as backups above.
  if (
    await claimSweep(ctx, "schema-snapshot", SCHEMA_SNAPSHOT_SWEEP_INTERVAL_MS, now)
  ) {
    try {
      await runScheduledSnapshots({ db: ctx.db, dialect: ctx.dialect }, now);
    } catch (e) {
      console.error("[schema-auto-snapshot] sweep failed", e);
    }
  }

  // Usage metering: drain any buffered request counts (a low-traffic isolate
  // may not hit the buffer's own flush thresholds between requests) and,
  // half-hourly, refresh the per-workspace storage/rows gauges.
  try {
    await flushUsage(ctx);
  } catch (e) {
    console.error("[usage] flush failed", e);
  }
  if (await claimSweep(ctx, "usage-gauges", USAGE_GAUGE_SWEEP_INTERVAL_MS, now)) {
    try {
      await sweepUsageGauges(ctx, now);
    } catch (e) {
      console.error("[usage-gauges] sweep failed", e);
    }
  }

  // CDC sinks: advance each enabled sink by at most one page. Not throttled
  // beyond the tick itself — a replica people watch should be seconds behind,
  // not minutes, and an idle sweep is one indexed SELECT that returns nothing.
  try {
    await processCdcSinks(ctx);
  } catch (e) {
    console.error("[cdc] sweep failed", e);
  }

  // External-DB migration runs: advance at most one due run by one bounded
  // slice per tick (lease-reclaimed, cursor-resumable — services/migrate.ts).
  // NOT throttled beyond the tick itself: a user is actively watching the
  // progress panel, and an idle sweep is a single indexed SELECT.
  try {
    await processMigrationRuns(ctx, { now });
  } catch (e) {
    console.error("[migrate-run] sweep failed", e);
  }

  if (await claimSweep(ctx, "activity-prune", ACTIVITY_PRUNE_INTERVAL_MS, now)) {
    const raw = env.ACTIVITY_RETENTION_DAYS;
    const days = raw == null || raw === "" ? DEFAULT_ACTIVITY_RETENTION_DAYS : Number(raw);
    await pruneOldActivity({ db: ctx.db, dialect: ctx.dialect }, days);
    // Sensitive-read audit rows get their own shorter retention so they don't
    // dominate the table; they're still bounded by the global prune above.
    const accessRaw = env.ACCESS_AUDIT_RETENTION_DAYS;
    const accessDays =
      accessRaw == null || accessRaw === ""
        ? DEFAULT_ACCESS_AUDIT_RETENTION_DAYS
        : Number(accessRaw);
    await pruneOldActivityByPrefix(
      { db: ctx.db, dialect: ctx.dialect },
      accessDays,
      "access.",
    );
    // MCP tool-call audit rows — same reasoning as the read audit above: one
    // row per agent tool call would otherwise crowd out the mutation history.
    const mcpRaw = env.MCP_AUDIT_RETENTION_DAYS;
    const mcpDays =
      mcpRaw == null || mcpRaw === ""
        ? DEFAULT_MCP_AUDIT_RETENTION_DAYS
        : Number(mcpRaw);
    await pruneOldActivityByPrefix(
      { db: ctx.db, dialect: ctx.dialect },
      mcpDays,
      "mcp.",
    );
    // Schedule-flow fire ledger. Rides the daily clock rather than carrying a
    // retention setting: the safe cutoff is not a preference but a consequence
    // of the catch-up window, since an entry older than that can never be
    // consulted by a scan again.
    try {
      await pruneScheduleFires(ctx, now);
    } catch (e) {
      console.error("[schedule-flow] ledger prune failed", e);
    }

    // Trace spans are high-volume (one per sampled request) with a short useful
    // life — prune on the same daily clock as activity, default 7 days.
    const spanRaw = env.TRACES_RETENTION_DAYS;
    const spanDays =
      spanRaw == null || spanRaw === ""
        ? DEFAULT_TRACES_RETENTION_DAYS
        : Number(spanRaw);
    await pruneOldSpans({ db: ctx.db, dialect: ctx.dialect }, spanDays);

    // Product analytics (#22) rides the same daily clock. The two streams get
    // separate budgets: tracked events are pure volume, while error
    // occurrences carry stacks worth keeping around a triage cycle.
    const analyticsRaw = env.ANALYTICS_RETENTION_DAYS;
    const analyticsDays =
      analyticsRaw == null || analyticsRaw === ""
        ? DEFAULT_ANALYTICS_RETENTION_DAYS
        : Number(analyticsRaw);
    const errorsRaw = env.ERRORS_RETENTION_DAYS;
    const errorDays =
      errorsRaw == null || errorsRaw === ""
        ? DEFAULT_ERRORS_RETENTION_DAYS
        : Number(errorsRaw);
    try {
      await pruneAnalyticsEvents({ db: ctx.db, dialect: ctx.dialect }, analyticsDays);
      await pruneErrorEvents({ db: ctx.db, dialect: ctx.dialect }, errorDays);
    } catch (e) {
      // Telemetry pruning must never take down the tick that also runs jobs,
      // backups and scheduled publishing.
      console.error("[analytics-prune] sweep failed", e);
    }

    // Retained broadcast messages. No retention setting: `retentionHours` is
    // per RULE and already capped, and `readReplay` clamps each channel to its
    // own window on the way in — so the prune only has to enforce the ceiling,
    // in one ranged DELETE on the `day` key rather than a scan per channel.
    try {
      await pruneBroadcastMessages(ctx, now.getTime());
    } catch (e) {
      console.error("[broadcast-prune] sweep failed", e);
    }
  }
};

/**
 * Bun-only: schedule a tick every 30 seconds. We don't try to align to
 * wall-clock minute boundaries — `dueCronFunctions` filters by the cron
 * pattern's previous fire time falling inside the elapsed window, so jitter
 * is fine.
 */
export const startBunScheduler = (env: Env): (() => void) => {
  void cronTick(env).catch((e) => console.error("[cron] initial tick", e));
  const id = setInterval(() => {
    void cronTick(env).catch((e) => console.error("[cron] tick", e));
  }, 30_000);
  return () => clearInterval(id);
};
