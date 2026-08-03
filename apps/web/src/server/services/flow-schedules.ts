import { eq, lt, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { compileCondition } from "@backlex/db";
import {
  SCHEDULE_CATCHUP_MS,
  type ScheduleSpec,
  fireInstant,
  firesWithin,
  parseScheduleTrigger,
  scanRange,
} from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../context";
import { loadCollection } from "./items/collection-loader";
import { deserializeRow } from "./items/serialize";
import { deletedFilter, queryAll, whereOf } from "./items/sql-helpers";
import { runFlowById } from "./flows";

/**
 * Date-relative flow triggers: the scan, the exactly-once claim, and the
 * fan-out that runs a flow once per matching row.
 *
 * The pure half — what "three days before, at 09:00" resolves to, and which raw
 * column values are worth pulling out of SQL — lives in
 * `@backlex/core/schedule`, with no clock or database in sight. This file is
 * only the part that has to touch both.
 */

const flowsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;

const firesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flowScheduleFires : sqlite.schema.flowScheduleFires;

/**
 * How many candidate rows one flow may pull per tick.
 *
 * Generous, because the ledger — not this number — is what keeps the work
 * bounded in steady state: a row fires once and is never dispatched again, so a
 * healthy schedule sees a handful of candidates per tick regardless of how
 * large the collection is. The cap only bites when a schedule is first switched
 * on over a big backlog, and the scan logs when it does rather than quietly
 * covering less than it claims.
 */
const SCAN_LIMIT = 1000;

interface ScheduleFlowRow {
  id: string;
  name: string;
  tenantId: string | null;
  spec: ScheduleSpec;
  createdAt: Date | number | string | null;
}

/**
 * Active flows with a `schedule:` trigger, spec already parsed.
 *
 * A flow whose spec no longer parses is logged and skipped rather than thrown
 * on: this runs across every flow in the instance, and one malformed row must
 * not stop every other workspace's reminders from going out.
 */
export const listScheduleFlows = async (ctx: Ctx): Promise<ScheduleFlowRow[]> => {
  const t = flowsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.active, true))) as Array<{
    id: string;
    name: string;
    tenantId: string | null;
    trigger: string;
    createdAt: Date | number | string | null;
  }>;
  const out: ScheduleFlowRow[] = [];
  for (const r of rows) {
    if (!r.trigger.startsWith("schedule:")) continue;
    const spec = parseScheduleTrigger(r.trigger);
    if (!spec) {
      console.error(`[schedule-flow] unparseable trigger on ${r.name} (${r.id})`);
      continue;
    }
    out.push({
      id: r.id,
      name: r.name,
      tenantId: r.tenantId,
      spec,
      createdAt: r.createdAt,
    });
  }
  return out;
};

/**
 * A millisecond instant as the dialect writes timestamps.
 *
 * Mirrors `nowFor`: an ISO string on Postgres (which round-trips through
 * `timestamptz` without the driver having to guess a type for a dynamic
 * table's column) and epoch milliseconds on SQLite. Getting this wrong does not
 * error — it compares a number against a text column and matches nothing — so
 * it is one helper rather than a literal at each call site.
 */
const tsLiteral = (dialect: "pg" | "sqlite", ms: number): string | number =>
  dialect === "pg" ? new Date(ms).toISOString() : ms;

const asMs = (value: Date | number | string | null): number | null => {
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Try to claim (flow, row, instant) for dispatch. True means this process owns
 * it and must run the flow; false means somebody already has.
 *
 * `onConflictDoNothing().returning()` is the whole mechanism: the unique index
 * decides, so two instances ticking in the same second cannot both win, and no
 * read-then-write window exists for them to race through.
 *
 * A claim FAILURE returns false — the flow does not run. That is the right way
 * round: an unsent reminder is recoverable on the next tick once the database
 * is answering again, and a reminder sent without a ledger entry would be sent
 * again every tick for two days.
 */
const claimFire = async (
  ctx: Ctx,
  flow: ScheduleFlowRow,
  rowId: string,
  fireAtMs: number,
): Promise<boolean> => {
  const t = firesTable(ctx.dialect);
  try {
    const inserted = (await (ctx.db as any)
      .insert(t)
      .values({
        id: crypto.randomUUID(),
        tenantId: flow.tenantId,
        flowId: flow.id,
        rowId,
        // Drizzle owns the conversion for these typed system columns; a raw
        // number here silently stores the wrong thing on the pg side.
        fireAt: new Date(fireAtMs),
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: [t.flowId, t.rowId, t.fireAt] })
      .returning({ id: t.id })) as { id: string }[];
    return inserted.length > 0;
  } catch (e) {
    console.error(`[schedule-flow:${flow.name}] claim failed for row ${rowId}`, e);
    return false;
  }
};

/**
 * Scan one flow's collection and dispatch the rows that are due.
 *
 * The window is `(from, now]`, where `from` reaches back over the catch-up
 * window — so a tick that follows a restart still finds what the missed ticks
 * would have found — but never earlier than the flow itself existed. Without
 * that second bound, switching a schedule on over a collection of long-overdue
 * invoices would mail every one of them at once, which is the sort of thing an
 * operator only gets to undo by apologising.
 */
const runScheduleFlow = async (
  ctx: Ctx,
  flow: ScheduleFlowRow,
  now: Date,
): Promise<void> => {
  const nowMs = now.getTime();
  const createdMs = asMs(flow.createdAt);
  const from = Math.max(nowMs - SCHEDULE_CATCHUP_MS, createdMs ?? 0);
  if (from >= nowMs) return;

  const { spec } = flow;
  if (!flow.tenantId) {
    // Same fail-closed posture as event flows: a flow we cannot attribute to a
    // workspace must not read anybody's rows.
    return;
  }

  const collection = await loadCollection(ctx, flow.tenantId, spec.collection);
  const field = collection.fields.find((f) => f.name === spec.field);
  if (!field || field.type !== "timestamp") {
    console.error(
      `[schedule-flow:${flow.name}] field "${spec.field}" is not a timestamp on ${spec.collection}`,
    );
    return;
  }

  const range = scanRange(spec, from, nowMs);
  const auth: AuthSubject = {
    userId: null,
    email: null,
    roles: [],
    tenantId: flow.tenantId,
  };

  const filters = [
    collection.tenantScoped
      ? sql`${sql.identifier("tenant_id")} = ${flow.tenantId}`
      : null,
    deletedFilter(collection),
    // A versioned collection's drafts and archived rows are not live content;
    // reminding somebody about a deadline on a row that was never published
    // would be acting on an editor's scratch space.
    collection.versioned ? sql`${sql.identifier("_status")} = 'published'` : null,
    sql`${sql.identifier(spec.field)} IS NOT NULL`,
    sql`${sql.identifier(spec.field)} >= ${tsLiteral(ctx.dialect, range.minMs)}`,
    sql`${sql.identifier(spec.field)} <= ${tsLiteral(ctx.dialect, range.maxMs)}`,
    spec.where
      ? compileCondition(spec.where, auth, undefined, undefined, {
          dialect: ctx.dialect,
          now: nowMs,
        })
      : null,
  ];

  let candidates: Record<string, unknown>[];
  try {
    candidates = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${sql.identifier(collection.physicalTable)} ${whereOf(...filters)} LIMIT ${SCAN_LIMIT}`,
    );
  } catch (e) {
    console.error(`[schedule-flow:${flow.name}] scan failed`, e);
    return;
  }
  if (candidates.length === SCAN_LIMIT) {
    // Stated rather than swallowed: past this point the scan is covering less
    // than the schedule promises, and the next tick will not catch up on its
    // own because the same rows sort in again.
    console.warn(
      `[schedule-flow:${flow.name}] scan hit the ${SCAN_LIMIT}-row cap — some due rows were not dispatched this tick`,
    );
  }

  for (const raw of candidates) {
    const instant = fireInstant(raw[spec.field], spec);
    // The SQL range is a pre-filter that deliberately over-fetches when a wall
    // clock is involved; THIS is the decision.
    if (!firesWithin(instant, from, nowMs)) continue;
    const rowId = raw[collection.pkColumn];
    if (rowId === null || rowId === undefined || rowId === "") continue;
    const id = String(rowId);

    if (!(await claimFire(ctx, flow, id, instant as number))) continue;

    const data = deserializeRow(
      raw,
      collection.fields,
      ctx.dialect,
      collection.ownerScoped,
      null,
      collection,
    );
    try {
      // `data` is the row, exactly as it is for an event-triggered run, so a
      // flow rewritten from `event:` to `schedule:` keeps every `{{ data.x }}`
      // it already had. `subject` lets the ops that patch a row default to the
      // one the schedule is about.
      await runFlowById(ctx, flow.id, data, auth, {
        subject: { collection: collection.slug, id },
      });
    } catch (e) {
      // The claim is already spent, and deliberately so: retrying arbitrary
      // operator work on the next tick is how one failing email turns into
      // hundreds. The run is logged and the activity row records the failure.
      console.error(`[schedule-flow:${flow.name}] run failed for row ${id}`, e);
    }
  }
};

/**
 * Dispatch every due schedule flow. Called once per scheduler tick.
 *
 * Sequential across flows on purpose: each one issues a scan plus up to a
 * ledger write and a full flow run per due row, and running every workspace's
 * schedules at once would hand D1 a burst it answers with timeouts.
 */
export const runDueScheduleFlows = async (ctx: Ctx, now: Date): Promise<void> => {
  const flows = await listScheduleFlows(ctx);
  for (const flow of flows) {
    try {
      await runScheduleFlow(ctx, flow, now);
    } catch (e) {
      console.error(`[schedule-flow:${flow.name}] crashed`, e);
    }
  }
};

/**
 * Drop ledger entries that have fallen behind the catch-up window.
 *
 * Safe because a scan can never reach that far back, so an entry down there can
 * never be consulted again. The margin is a full extra window, so that a clock
 * that steps backwards slightly cannot delete an entry that is still load-
 * bearing.
 */
export const pruneScheduleFires = async (ctx: Ctx, now: Date): Promise<void> => {
  const t = firesTable(ctx.dialect);
  const cutoff = new Date(now.getTime() - SCHEDULE_CATCHUP_MS * 2);
  await (ctx.db as any).delete(t).where(lt(t.fireAt, cutoff));
};

/** Exported for the tests, which assert the window/claim behaviour directly
 *  rather than through a whole tick. */
export const __testing = { runScheduleFlow, claimFire, SCAN_LIMIT };
