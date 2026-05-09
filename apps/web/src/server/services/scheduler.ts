import { eq } from "drizzle-orm";
import { parseExpression } from "cron-parser";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AuthSubject } from "@workeros/core";
import { runFunction } from "./sandbox";
import { buildContext } from "../context";
import type { Env } from "../env";
import type { FunctionRow } from "./functions";
import { listCronFlows, runFlowById } from "./flows";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.functions : sqlite.schema.functions;

const SYSTEM_AUTH: AuthSubject = { userId: null, email: null, roles: [] };

/**
 * Per-process tick state. `lastTickAt` is the wall-clock time we last
 * scanned for due crons; the next tick fires every cron whose pattern's
 * `prev()` falls inside `(lastTickAt, now]`. This collapses missed
 * minutes (after a restart or pause) into at most one execution per
 * pattern per missed window — i.e. workeros guarantees at-most-once
 * dispatch per minute, never doubles.
 */
let lastTickAt: Date | null = null;

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

  const ctx = buildContext(env);
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.trigger, "cron"))) as FunctionRow[];

  const due = dueCronFunctions(rows, prev, now);

  await Promise.all(
    due.map(async (fn) => {
      try {
        const result = await runFunction(
          fn.code,
          { ctx, auth: SYSTEM_AUTH },
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
