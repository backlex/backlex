import { eq } from "drizzle-orm";
import { parseExpression } from "cron-parser";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AuthSubject } from "@backlex/core";
import { runFunction } from "./sandbox";
import { buildContext } from "../context";
import type { Env } from "../env";
import type { FunctionRow } from "./functions";
import { listCronFlows, runFlowById, resumeContinuation } from "./flows";
import { claimDueTasks, deleteTask } from "./scheduled-tasks";
import { pruneOldActivity, pruneOldActivityByPrefix } from "./activity";

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

/** When activity pruning last ran (per process). Pruning is throttled to
 *  once every 24h so the cron tick stays cheap; a scan + DELETE on a
 *  growing table is overkill on a per-minute schedule. */
let lastActivityPruneAt: number = 0;
const ACTIVITY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVITY_RETENTION_DAYS = 90;
// Sensitive-read audit rows (`access.*`) are opt-in but higher-volume, so they
// get a shorter default clock than the global retention.
const DEFAULT_ACCESS_AUDIT_RETENTION_DAYS = 30;

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
        if (task.payload?.kind !== "flow-continuation") {
          // Unknown payload kind — drop the row so it doesn't keep getting
          // claimed forever.
          await deleteTask(ctx, task.id);
          return;
        }
        await resumeContinuation(ctx, task.payload);
        await deleteTask(ctx, task.id);
      } catch (e) {
        console.error(`[scheduled-task:${task.id}] resume failed`, e);
        // Leave the row claimed so a human can inspect / re-queue manually.
      }
    }),
  );

  if (now.getTime() - lastActivityPruneAt >= ACTIVITY_PRUNE_INTERVAL_MS) {
    lastActivityPruneAt = now.getTime();
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
