/**
 * KPI alerts — the figure comes and finds you.
 *
 * A KPI answers a question when somebody opens a page, and the figures that
 * matter most are precisely the ones nobody thinks to open. A cancellation rate
 * that doubled overnight is not something you go looking for.
 *
 * ## Firing on the transition, not on the tick
 *
 * The scheduler runs every minute. A watch that notified whenever the condition
 * held would send the same alert 1,440 times a day for as long as the problem
 * lasted, which teaches people to mute the channel — and a muted alert is worse
 * than no alert, because it looks like coverage. So the breach is a STATE
 * (`alert_firing`), and only the edge into it notifies. Coming back inside the
 * threshold clears the flag, so the next breach speaks up again.
 *
 * ## Who it runs as
 *
 * With the system subject, unclamped by any one reader's permissions — an alert
 * is the workspace's own watch on its own data, not a view of it.
 *
 * Which is exactly why the notification goes to the workspace's ADMINS rather
 * than being broadcast. A broadcast row (`user_id` null) is visible to every
 * authenticated member, and the figure in it was computed without resolving
 * anyone's grants: "Average salary is 42,000, below the 50,000 threshold" sent
 * to all staff is a leak dressed as an alert. Admins are the identities whose
 * read of that number is not in question.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { SYSTEM_ROLES } from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../context";
import { nowFor } from "./items-helpers";
import { type KpiResult, type KpiRow, runKpi } from "./kpis";

const kpisTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.kpis : sqlite.schema.kpis;
const notificationsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.notifications : sqlite.schema.notifications;
const rolesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.roles : sqlite.schema.roles;
const userRolesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.userRoles : sqlite.schema.userRoles;

/** The workspace's admin user ids — the recipients of an unclamped figure. */
const adminUserIds = async (ctx: Ctx, tenantId: string): Promise<string[]> => {
  const r = rolesTable(ctx.dialect);
  const ur = userRolesTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select({ userId: ur.userId })
      .from(ur)
      .innerJoin(r, eq(ur.roleId, r.id))
      .where(and(eq(r.tenantId, tenantId), eq(r.name, SYSTEM_ROLES.admin)))) as {
      userId: string;
    }[];
    return [...new Set(rows.map((x) => x.userId))];
  } catch {
    return [];
  }
};

/** The watch runs as the workspace, not as a reader. */
const systemAuthFor = (tenantId: string): AuthSubject => ({
  plane: "platform",
  userId: null,
  email: null,
  roles: [SYSTEM_ROLES.admin],
  tenantId,
});

export interface KpiAlertVerdict {
  /** True when the figure is outside the threshold right now. */
  breaching: boolean;
  /** The number the verdict was reached on — null when there is nothing to
   *  compare, which is NOT a breach. */
  observed: number | null;
}

/**
 * Decide whether a result breaches its KPI's threshold.
 *
 * A null observation never fires. An `avg` over an empty window is unknown, not
 * zero, and a `change_*` rule has nothing to say when there was no previous
 * period — waking someone at 3am because a table was quiet is how a watch loses
 * its credibility.
 *
 * Exported for tests: the arithmetic is the whole feature and it has no UI.
 */
export const evaluateAlert = (kpi: KpiRow, result: KpiResult): KpiAlertVerdict => {
  if (!kpi.alertOperator || kpi.alertValue === null || kpi.alertValue === undefined) {
    return { breaching: false, observed: null };
  }
  const point = result.point;
  // A grouped KPI has no single figure to compare; the threshold would have to
  // say which row it meant.
  if (!point) return { breaching: false, observed: null };

  const isChange = kpi.alertOperator.startsWith("change_");
  const observed = isChange ? point.deltaPct : point.value;
  if (observed === null || observed === undefined || !Number.isFinite(observed)) {
    return { breaching: false, observed: null };
  }
  const threshold = kpi.alertValue;
  const breaching =
    kpi.alertOperator === "above" || kpi.alertOperator === "change_above"
      ? observed > threshold
      : observed < threshold;
  return { breaching, observed };
};

/** Human-readable one-liner for the notification body. */
const describe = (kpi: KpiRow, observed: number): string => {
  const isChange = kpi.alertOperator?.startsWith("change_");
  const shown = isChange
    ? `${(observed * 100).toFixed(1)}%`
    : new Intl.NumberFormat("en").format(observed);
  const limit = isChange
    ? `${((kpi.alertValue ?? 0) * 100).toFixed(1)}%`
    : new Intl.NumberFormat("en").format(kpi.alertValue ?? 0);
  const direction =
    kpi.alertOperator === "above" || kpi.alertOperator === "change_above"
      ? "above"
      : "below";
  const what = isChange ? "changed by" : "is";
  return `${kpi.name} ${what} ${shown}, ${direction} the ${limit} threshold.`;
};

/**
 * Evaluate every watched KPI across every workspace and notify on new
 * breaches. Called from the scheduler tick; never throws — one broken
 * definition must not stop the others from being checked.
 *
 * Returns the slugs that fired, which is what the tests assert on.
 */
export const runKpiAlerts = async (ctx: Ctx, now: Date = new Date()): Promise<string[]> => {
  const t = kpisTable(ctx.dialect);
  let watched: Record<string, unknown>[];
  try {
    watched = (await (ctx.db as any)
      .select()
      .from(t)
      .where(isNotNull(t.alertOperator))) as Record<string, unknown>[];
  } catch {
    // Table not migrated yet — same posture as the rest of the KPI services.
    return [];
  }

  const fired: string[] = [];
  for (const raw of watched) {
    const kpi = rowToKpiRow(raw);
    // Rows span every workspace, so each evaluation carries its own tenant —
    // otherwise a watch would read the wrong workspace's data.
    const tenantId = kpi.tenantId;
    try {
      const result = await runKpi(ctx, systemAuthFor(tenantId), tenantId, kpi, {
        rangeDays: 1,
      });
      const { breaching, observed } = evaluateAlert(kpi, result);

      if (breaching && !kpi.alertFiring) {
        const told = await notify(ctx, kpi, observed as number);
        // Only remember the breach once somebody has actually been told.
        // Flipping the flag on a notification that reached nobody would
        // suppress every later tick, and the breach would pass in silence.
        if (told > 0) {
          await setFiring(ctx, kpi, true, now);
          fired.push(kpi.slug);
        }
      } else if (!breaching && kpi.alertFiring) {
        // Recovered. No "all clear" message — the point of clearing the flag is
        // that the NEXT breach is heard, not that recovery is itself news.
        await setFiring(ctx, kpi, false, null);
      }
    } catch (e) {
      console.error(`[kpi-alert:${kpi.slug}] evaluation failed`, e);
    }
  }
  return fired;
};

/** Returns how many recipients were written — 0 means nobody was told, which
 *  the caller treats as "did not fire" so the flag stays clear and a later
 *  tick tries again rather than silently swallowing the breach. */
const notify = async (ctx: Ctx, kpi: KpiRow, observed: number): Promise<number> => {
  const admins = await adminUserIds(ctx, kpi.tenantId);
  if (admins.length === 0) return 0;
  const n = notificationsTable(ctx.dialect);
  const now = nowFor(ctx.dialect);
  const title = `KPI alert: ${kpi.name}`;
  const body = describe(kpi, observed);
  // One row per admin rather than a broadcast: the list endpoint shows
  // broadcasts to EVERY authenticated member, and this figure was computed
  // without resolving anyone's read grants.
  await (ctx.db as any).insert(n).values(
    admins.map((userId) => ({
      id: crypto.randomUUID(),
      tenantId: kpi.tenantId || null,
      userId,
      title,
      body,
      url: `/kpis`,
      flowId: null,
      readAt: null,
      createdAt: now,
    })),
  );
  return admins.length;
};

const setFiring = async (
  ctx: Ctx,
  kpi: KpiRow,
  firing: boolean,
  firedAt: Date | null,
): Promise<void> => {
  const t = kpisTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      alertFiring: firing,
      ...(firedAt
        ? { alertLastFiredAt: ctx.dialect === "pg" ? firedAt : firedAt.getTime() }
        : {}),
    })
    .where(and(eq(t.tenantId, kpi.tenantId), eq(t.id, kpi.id)));
};

/** The subset of `rowToKpi` this module needs, without exporting the private
 *  one — kept in step by the shared `KpiRow` type. */
const rowToKpiRow = (row: Record<string, unknown>): KpiRow => ({
  id: row.id as string,
  tenantId: (row.tenantId ?? row.tenant_id ?? "") as string,
  slug: row.slug as string,
  name: row.name as string,
  description: (row.description ?? null) as string | null,
  collection: row.collection as string,
  agg: row.agg as string,
  field: (row.field ?? null) as string | null,
  filter: (row.filter ?? null) as Record<string, unknown> | null,
  dateField: (row.dateField ?? row.date_field ?? null) as string | null,
  groupBy: (row.groupBy ?? row.group_by ?? null) as string | null,
  topN: (row.topN ?? row.top_n ?? null) as number | null,
  format: (row.format ?? "number") as string,
  unit: (row.unit ?? null) as string | null,
  decimals: (row.decimals ?? null) as number | null,
  direction: (row.direction ?? "neutral") as string,
  alertOperator: (row.alertOperator ?? row.alert_operator ?? null) as string | null,
  alertValue: (row.alertValue ?? row.alert_value ?? null) as number | null,
  alertFiring: Boolean(row.alertFiring ?? row.alert_firing ?? false),
  alertLastFiredAt: (row.alertLastFiredAt ?? row.alert_last_fired_at ?? null) as
    | Date
    | number
    | null,
  createdBy: (row.createdBy ?? row.created_by ?? null) as string | null,
  createdAt: (row.createdAt ?? row.created_at ?? null) as Date | number | null,
  updatedAt: (row.updatedAt ?? row.updated_at ?? null) as Date | number | null,
});
