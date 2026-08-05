/**
 * KPI alerts — the watch that fires on the edge into a breach.
 *
 * The load-bearing behaviour is not "does it notify when the number is high",
 * it is "does it notify EXACTLY ONCE while the number stays high". The
 * scheduler runs every minute; a watch that re-notified on every tick would
 * send the same alert 1,440 times a day, and a channel people mute is worse
 * than no channel because it looks like coverage. So the transition is what is
 * asserted here, along with the cases that must NOT fire: an unknown
 * observation, and a grouped KPI with no single figure to compare.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { evaluateAlert, runKpiAlerts } from "../src/server/services/kpi-alerts";
import type { KpiResult, KpiRow } from "../src/server/services/kpis";

const JSON_HEADERS = { "content-type": "application/json" };

const kpiRow = (over: Partial<KpiRow>): KpiRow =>
  ({
    id: "k", tenantId: "t", slug: "s", name: "S", description: null,
    collection: "c", agg: "count", field: null, filter: null, dateField: null,
    groupBy: null, topN: null, format: "number", unit: null, decimals: null,
    direction: "up", alertOperator: null, alertValue: null, alertFiring: false,
    alertLastFiredAt: null, createdBy: null, createdAt: null, updatedAt: null,
    ...over,
  }) as KpiRow;

const result = (over: Partial<KpiResult>): KpiResult =>
  ({
    slug: "s", name: "S", description: null, collection: "c", format: "number",
    unit: null, decimals: null, direction: "up", groupBy: null,
    window: { from: 0, to: 1 }, previousWindow: { from: -1, to: 0 },
    point: { value: 10, previousValue: 5, delta: 5, deltaPct: 1 },
    rows: null, series: null, computedAt: 0,
    ...over,
  }) as KpiResult;

describe("kpi alerts: the verdict", () => {
  test("an unwatched KPI never breaches", () => {
    expect(evaluateAlert(kpiRow({}), result({})).breaching).toBe(false);
  });

  test("`above` compares the value", () => {
    const kpi = kpiRow({ alertOperator: "above", alertValue: 8 });
    expect(evaluateAlert(kpi, result({})).breaching).toBe(true);
    expect(
      evaluateAlert(kpi, result({ point: { value: 3, previousValue: 1, delta: 2, deltaPct: 2 } }))
        .breaching,
    ).toBe(false);
  });

  test("`below` compares the value the other way", () => {
    const kpi = kpiRow({ alertOperator: "below", alertValue: 8 });
    expect(evaluateAlert(kpi, result({})).breaching).toBe(false);
    expect(
      evaluateAlert(kpi, result({ point: { value: 3, previousValue: 1, delta: 2, deltaPct: 2 } }))
        .breaching,
    ).toBe(true);
  });

  test("`change_above` compares deltaPct, in fractions", () => {
    // 0.2 means 20%, the units deltaPct reports in — not 20.
    const kpi = kpiRow({ alertOperator: "change_above", alertValue: 0.2 });
    expect(
      evaluateAlert(kpi, result({ point: { value: 6, previousValue: 5, delta: 1, deltaPct: 0.2 } }))
        .breaching,
    ).toBe(false); // exactly at the threshold is not past it
    expect(
      evaluateAlert(kpi, result({ point: { value: 7, previousValue: 5, delta: 2, deltaPct: 0.4 } }))
        .breaching,
    ).toBe(true);
  });

  test("an unknown observation never fires", () => {
    // An avg over an empty window is not zero, and a change with no baseline
    // has nothing to say. Waking someone because a table was quiet is how a
    // watch loses its credibility.
    const onValue = kpiRow({ alertOperator: "below", alertValue: 5 });
    expect(
      evaluateAlert(onValue, result({ point: { value: null, previousValue: null, delta: null, deltaPct: null } }))
        .breaching,
    ).toBe(false);

    const onChange = kpiRow({ alertOperator: "change_below", alertValue: -0.1 });
    expect(
      evaluateAlert(onChange, result({ point: { value: 5, previousValue: 0, delta: 5, deltaPct: null } }))
        .breaching,
    ).toBe(false);
  });

  test("a grouped KPI has no single figure to compare", () => {
    const kpi = kpiRow({ alertOperator: "above", alertValue: 1, groupBy: "status" });
    expect(
      evaluateAlert(kpi, result({ point: null, rows: [{ label: "a", value: 99, previousValue: 1, delta: 98, deltaPct: 98 }] }))
        .breaching,
    ).toBe(false);
  });
});

describe("kpi alerts: firing on the transition", () => {
  let h: TestHarness;
  const slug = `alerts_${Date.now()}`;

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  const unread = async (): Promise<{ title: string; body: string }[]> => {
    const res = await h.fetch("/api/notifications");
    const j = (await res.json()) as { data: { title: string; body: string }[] };
    return (j.data ?? []).filter((n) => n.title.startsWith("KPI alert:"));
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await post("/api/collections", { slug, fields: [{ name: "n", type: "integer" }] });
    // Three rows — above a threshold of 2.
    for (const n of [1, 2, 3]) await post(`/api/items/${slug}`, { n });
    await post("/api/admin/kpis", {
      slug: "row-count",
      name: "Row count",
      collection: slug,
      agg: "count",
      alertOperator: "above",
      alertValue: 2,
      direction: "down",
    });
  });
  afterAll(() => h.cleanup());

  test("fires once on the way in, and stays quiet while it keeps breaching", async () => {
    const ctx = await buildContext(h.env);

    const first = await runKpiAlerts(ctx);
    expect(first).toContain("row-count");
    expect((await unread()).length).toBe(1);

    // The scheduler runs every minute. Three more ticks, still breaching.
    for (let i = 0; i < 3; i++) {
      const again = await runKpiAlerts(ctx);
      expect(again).toEqual([]);
    }
    expect((await unread()).length).toBe(1);
  });

  test("recovering clears the flag so the next breach is heard", async () => {
    const ctx = await buildContext(h.env);
    const list = (await (await h.fetch(`/api/items/${slug}?limit=10`)).json()) as {
      data: { id: string }[];
    };
    // Drop below the threshold — no "all clear" message, just a reset.
    await h.fetch(`/api/items/${slug}/${list.data[0]!.id}`, { method: "DELETE" });
    await h.fetch(`/api/items/${slug}/${list.data[1]!.id}`, { method: "DELETE" });
    expect(await runKpiAlerts(ctx)).toEqual([]);
    expect((await unread()).length).toBe(1);

    // Breach again — and this time it must speak up.
    await post(`/api/items/${slug}`, { n: 9 });
    await post(`/api/items/${slug}`, { n: 9 });
    expect(await runKpiAlerts(ctx)).toContain("row-count");
    expect((await unread()).length).toBe(2);
  });

  test("the notification says the figure and the threshold", async () => {
    const rows = await unread();
    expect(rows[0]!.title).toBe("KPI alert: Row count");
    expect(rows[0]!.body).toMatch(/Row count is 3, above the 2 threshold\./);
  });
});

describe("kpi alerts: a half-configured watch is refused", () => {
  let h: TestHarness;
  const slug = `alertcfg_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, fields: [{ name: "n", type: "integer" }] }),
    });
  });
  afterAll(() => h.cleanup());

  const create = (body: Record<string, unknown>) =>
    h.fetch("/api/admin/kpis", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "X", collection: slug, agg: "count", ...body }),
    });

  test("an operator with no threshold cannot decide anything", async () => {
    const res = await create({ slug: "op-only", alertOperator: "above" });
    expect(res.status).toBe(422);
  });

  test("a threshold with no operator is a number nobody compares", async () => {
    const res = await create({ slug: "value-only", alertValue: 5 });
    expect(res.status).toBe(422);
  });

  test("neither is fine — most KPIs are not watched", async () => {
    const res = await create({ slug: "unwatched" });
    expect(res.status).toBe(201);
  });
});

/**
 * Editing the rule resets the breach state.
 *
 * `alert_firing` is state about the OLD threshold. Left behind when the rule
 * moves — and especially when the watch is REMOVED — it strands: the scheduler
 * only evaluates watched KPIs, so nothing would ever clear it, and the tile
 * would wear a red Alert badge for the rest of its life.
 */
describe("kpi alerts: the firing flag follows the rule", () => {
  let h: TestHarness;
  const slug = `alertreset_${Date.now()}`;
  let kpiId = "";

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  const patch = (body: unknown) =>
    h.fetch(`/api/admin/kpis/${kpiId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  const read = async () =>
    ((await (await h.fetch(`/api/admin/kpis/${kpiId}`)).json()) as {
      data: { alertFiring: boolean; alertOperator: string | null };
    }).data;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await post("/api/collections", { slug, fields: [{ name: "n", type: "integer" }] });
    for (const n of [1, 2, 3]) await post(`/api/items/${slug}`, { n });
    const created = (await (
      await post("/api/admin/kpis", {
        slug: "watched",
        name: "Watched",
        collection: slug,
        agg: "count",
        alertOperator: "above",
        alertValue: 2,
      })
    ).json()) as { data: { id: string } };
    kpiId = created.data.id;
    await runKpiAlerts(await buildContext(h.env));
  });
  afterAll(() => h.cleanup());

  test("it is firing to begin with", async () => {
    expect((await read()).alertFiring).toBe(true);
  });

  test("moving the threshold resets it — the flag was about the old rule", async () => {
    expect((await patch({ alertValue: 99 })).status).toBe(200);
    expect((await read()).alertFiring).toBe(false);
  });

  test("removing the watch clears it rather than stranding a red badge", async () => {
    // Re-arm and re-fire first.
    await patch({ alertValue: 2 });
    await runKpiAlerts(await buildContext(h.env));
    expect((await read()).alertFiring).toBe(true);

    expect((await patch({ alertOperator: null, alertValue: null })).status).toBe(200);
    const after = await read();
    expect(after.alertOperator).toBeNull();
    // Without the reset this stays true forever: the scheduler skips unwatched
    // KPIs, so nothing would ever come back to clear it.
    expect(after.alertFiring).toBe(false);
  });

  test("an unrelated edit leaves the breach state alone", async () => {
    await patch({ alertOperator: "above", alertValue: 2 });
    await runKpiAlerts(await buildContext(h.env));
    expect((await read()).alertFiring).toBe(true);
    expect((await patch({ name: "Renamed" })).status).toBe(200);
    expect((await read()).alertFiring).toBe(true);
  });
});

/**
 * The alert is addressed, not broadcast.
 *
 * The watch evaluates with the system subject — unclamped by anyone's read
 * grants — so the figure it carries is not one every workspace member is
 * entitled to. A broadcast notification (`user_id` null) is shown to EVERY
 * authenticated member by the list endpoint, which would turn "Average salary
 * is 42,000, below the 50,000 threshold" into a leak dressed as an alert.
 */
describe("kpi alerts: an unclamped figure is not broadcast", () => {
  let h: TestHarness;
  const ts = Date.now();
  const slug = `alertaudience_${ts}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const post = (path: string, body: unknown) =>
      h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    await post("/api/collections", { slug, fields: [{ name: "n", type: "integer" }] });
    for (const n of [1, 2, 3]) await post(`/api/items/${slug}`, { n });
    await post("/api/admin/kpis", {
      slug: "audience",
      name: "Audience",
      collection: slug,
      agg: "count",
      alertOperator: "above",
      alertValue: 2,
    });
    await runKpiAlerts(await buildContext(h.env));
  });
  afterAll(() => h.cleanup());

  test("no notification row is a broadcast", async () => {
    const rows = (await (
      await h.fetch("/api/admin/db/sql/run", {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
        body: JSON.stringify({
          sql: "SELECT user_id, title FROM notifications WHERE title LIKE 'KPI alert%'",
        }),
      })
    ).json()) as { data: { rows: { user_id: string | null }[] }[] };
    const notifications = rows.data?.[rows.data.length - 1]?.rows ?? [];
    expect(notifications.length).toBeGreaterThan(0);
    // Every row names a recipient. A null here is the broadcast form.
    expect(notifications.every((n) => n.user_id !== null)).toBe(true);
  });

  test("a non-admin member does not receive it", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `member-${ts}@example.test`,
        password: "correct-horse-battery",
        name: "Member",
      }),
    });
    const res = await h.fetch("/api/notifications?limit=50");
    const j = (await res.json()) as { data: { title: string }[] };
    expect((j.data ?? []).filter((n) => n.title.startsWith("KPI alert:")).length).toBe(0);
  });
});
