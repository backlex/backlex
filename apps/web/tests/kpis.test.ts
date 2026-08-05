/**
 * Named KPIs — the shared definition layer.
 *
 * What is actually worth pinning down here is not CRUD but the two things a
 * KPI adds on top of `runItemsAggregate`, both of which fail silently when
 * they are wrong:
 *
 *   - the period comparison (which rows land in the window, which in the one
 *     before it, and what a delta means when the baseline is zero), and
 *   - the window comparison against a SYSTEM column like `created_at`, which
 *     `normalizeTemporalOperands` does not rewrite because it only knows about
 *     columns declared in `collections.fields`. On SQLite an un-serialized ISO
 *     bound against an INTEGER column does not error, it INVERTS — so the
 *     assertion that matters is that the window returns the rows inside it.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const DAY = 86_400_000;

interface KpiPoint {
  label?: string;
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  deltaPct: number | null;
}
interface KpiResult {
  slug: string;
  format: string;
  direction: string;
  window: { from: number; to: number } | null;
  previousWindow: { from: number; to: number } | null;
  point: KpiPoint | null;
  rows: KpiPoint[] | null;
  computedAt: number;
}

describe("kpis: period comparison + definition layer", () => {
  let h: TestHarness;
  const slug = `orders_${Date.now()}`;
  // Anchor every window to one instant so the suite does not depend on the
  // wall clock advancing mid-run.
  const anchor = Date.now();

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await post("/api/collections", {
      slug,
      fields: [
        { name: "status", type: "text", required: true },
        { name: "total", type: "integer" },
        { name: "placed_at", type: "timestamp" },
      ],
    });
    // Current window [anchor-7d, anchor): 100 + 50 = 150, two rows.
    await post(`/api/items/${slug}`, {
      status: "paid",
      total: 100,
      placed_at: new Date(anchor - 1 * DAY).toISOString(),
    });
    await post(`/api/items/${slug}`, {
      status: "paid",
      total: 50,
      placed_at: new Date(anchor - 2 * DAY).toISOString(),
    });
    // Previous window [anchor-14d, anchor-7d): 60, one row.
    await post(`/api/items/${slug}`, {
      status: "refunded",
      total: 60,
      placed_at: new Date(anchor - 10 * DAY).toISOString(),
    });
    // Outside both windows entirely — must never be counted.
    await post(`/api/items/${slug}`, {
      status: "paid",
      total: 9999,
      placed_at: new Date(anchor - 100 * DAY).toISOString(),
    });
  });
  afterAll(() => h.cleanup());

  const createKpi = (body: Record<string, unknown>) =>
    post("/api/admin/kpis", body);

  const run = async (ref: string, query = ""): Promise<KpiResult> => {
    const res = await h.fetch(`/api/admin/kpis/${ref}/run${query}`);
    expect(res.status).toBe(200);
    return (await res.json() as { data: KpiResult }).data;
  };

  test("sum over a window, compared against the window before it", async () => {
    const res = await createKpi({
      slug: "revenue",
      name: "Revenue",
      collection: slug,
      agg: "sum",
      field: "total",
      dateField: "placed_at",
      format: "money",
      direction: "up",
    });
    expect(res.status).toBe(201);

    const data = await run("revenue", `?to=${anchor}&rangeDays=7`);
    expect(data.window).toEqual({ from: anchor - 7 * DAY, to: anchor });
    expect(data.previousWindow).toEqual({ from: anchor - 14 * DAY, to: anchor - 7 * DAY });
    // 100 + 50 in the window; the -10d row is the baseline; -100d counts nowhere.
    expect(data.point!.value).toBe(150);
    expect(data.point!.previousValue).toBe(60);
    expect(data.point!.delta).toBe(90);
    expect(data.point!.deltaPct).toBeCloseTo(1.5, 10);
  });

  test("the KPI's own filter survives the window being ANDed onto it", async () => {
    await createKpi({
      slug: "paid-revenue",
      name: "Paid revenue",
      collection: slug,
      agg: "sum",
      field: "total",
      filter: { status: { _eq: "paid" } },
      dateField: "placed_at",
    });
    const data = await run("paid-revenue", `?to=${anchor}&rangeDays=7`);
    expect(data.point!.value).toBe(150);
    // The only row in the previous window is `refunded`, so the filter must
    // leave the baseline empty — a sum over no rows is a real zero.
    expect(data.point!.previousValue).toBe(0);
    // Baseline zero has no proportion to report; +∞% and +100% are both lies.
    expect(data.point!.deltaPct).toBeNull();
    expect(data.point!.delta).toBe(150);
  });

  test("window applies correctly to `created_at`, a system column", async () => {
    // Not covered by normalizeTemporalOperands (it is absent from
    // `collections.fields`), so this is the assertion that catches an
    // un-serialized bound inverting the comparison on SQLite.
    await createKpi({
      slug: "rows-created",
      name: "Rows created",
      collection: slug,
      agg: "count",
      dateField: "created_at",
    });
    const inWindow = await run("rows-created", `?to=${anchor + DAY}&rangeDays=1`);
    // Every row was inserted moments ago, so all four are inside this window
    // and none are in the one before it. An inverted comparison returns the
    // exact opposite and looks just as plausible.
    expect(inWindow.point!.value).toBe(4);
    expect(inWindow.point!.previousValue).toBe(0);
  });

  test("a KPI with no dateField reports a total and no fabricated comparison", async () => {
    await createKpi({
      slug: "all-orders",
      name: "All orders",
      collection: slug,
      agg: "count",
    });
    const data = await run("all-orders", `?to=${anchor}&rangeDays=7`);
    expect(data.window).toBeNull();
    expect(data.previousWindow).toBeNull();
    expect(data.point!.value).toBe(4);
    expect(data.point!.previousValue).toBeNull();
    expect(data.point!.delta).toBeNull();
    expect(data.point!.deltaPct).toBeNull();
  });

  test("grouped KPI pairs each label with its own baseline", async () => {
    await createKpi({
      slug: "revenue-by-status",
      name: "Revenue by status",
      collection: slug,
      agg: "sum",
      field: "total",
      dateField: "placed_at",
      groupBy: "status",
      topN: 10,
    });
    const data = await run("revenue-by-status", `?to=${anchor}&rangeDays=7`);
    expect(data.point).toBeNull();
    const paid = data.rows!.find((r) => r.label === "paid")!;
    expect(paid.value).toBe(150);
    // `paid` had no rows in the previous window — for a sum that is zero, not
    // unknown, so the delta is the full amount rather than null.
    expect(paid.previousValue).toBe(0);
    expect(paid.delta).toBe(150);
    // `refunded` exists only in the baseline, so it is absent from the current
    // window's top-N entirely rather than showing up as a phantom zero.
    expect(data.rows!.some((r) => r.label === "refunded")).toBe(false);
  });

  test("run is rejected for a collection the caller cannot read", async () => {
    // A second, non-admin user with no grant on the collection. The definition
    // is admin-authored, but evaluating it must not become a way to count rows
    // the reader was never allowed to list.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const signUp = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `viewer-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(signUp.ok).toBe(true);
    const res = await h.fetch(`/api/admin/kpis/all-orders/run`);
    expect(res.status).toBe(403);
  });
});

describe("kpis: definition integrity", () => {
  let h: TestHarness;
  const slug = `defs_${Date.now()}`;

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await post("/api/collections", {
      slug,
      fields: [{ name: "total", type: "integer" }],
    });
  });
  afterAll(() => h.cleanup());

  test("slug is unique per workspace", async () => {
    const first = await post("/api/admin/kpis", {
      slug: "dupe",
      name: "First",
      collection: slug,
      agg: "count",
    });
    expect(first.status).toBe(201);
    const second = await post("/api/admin/kpis", {
      slug: "dupe",
      name: "Second",
      collection: slug,
      agg: "count",
    });
    // The database decides this, not a pre-flight SELECT — but the caller
    // still gets the constraint explained rather than a 500.
    expect(second.status).toBe(422);
  });

  test("a non-count aggregate must name a field", async () => {
    const res = await post("/api/admin/kpis", {
      slug: "no-field",
      name: "No field",
      collection: slug,
      agg: "sum",
    });
    expect(res.status).toBe(422);
  });

  test("PATCH does not reset omitted format/direction to their defaults", async () => {
    const created = await post("/api/admin/kpis", {
      slug: "patchable",
      name: "Patchable",
      collection: slug,
      agg: "sum",
      field: "total",
      format: "money",
      direction: "down",
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const patched = await h.fetch(`/api/admin/kpis/${data.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(patched.status).toBe(200);
    const row = (await patched.json() as { data: { name: string; format: string; direction: string } }).data;
    expect(row.name).toBe("Renamed");
    // The trap that already cost saved_panels its `viz` values: `.default()`
    // survives `.partial()`, so a rename must not silently re-mean the KPI.
    expect(row.format).toBe("money");
    expect(row.direction).toBe("down");
  });

  test("non-admin cannot author a definition", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `nobody-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Nobody",
      }),
    });
    const res = await post("/api/admin/kpis", {
      slug: "sneaky",
      name: "Sneaky",
      collection: slug,
      agg: "count",
    });
    expect(res.status).toBe(403);
  });
});

/**
 * The bucketed series behind a KPI — the shape a sparkline draws.
 *
 * Two things here are easy to get wrong in a way that still looks like data:
 * the epoch units (SQLite stores ms in an INTEGER, Postgres a timestamptz
 * whose epoch comes back in seconds), and empty buckets. A slice with no rows
 * is a real gap; dropping it lets the chart join its neighbours and draw a
 * line claiming the quiet period never happened.
 */
describe("kpis: the series behind the number", () => {
  let h: TestHarness;
  const slug = `series_${Date.now()}`;
  const anchor = Date.now();

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await post("/api/collections", {
      slug,
      fields: [
        { name: "total", type: "integer" },
        { name: "at", type: "timestamp" },
      ],
    });
    // Two rows in the oldest day, one in the newest, nothing in between.
    await post(`/api/items/${slug}`, { total: 5, at: new Date(anchor - 3.5 * DAY).toISOString() });
    await post(`/api/items/${slug}`, { total: 5, at: new Date(anchor - 3.2 * DAY).toISOString() });
    await post(`/api/items/${slug}`, { total: 7, at: new Date(anchor - 0.5 * DAY).toISOString() });
    await post("/api/admin/kpis", {
      slug: "daily-total",
      name: "Daily total",
      collection: slug,
      agg: "sum",
      field: "total",
      dateField: "at",
    });
    await post("/api/admin/kpis", {
      slug: "no-date",
      name: "No date",
      collection: slug,
      agg: "count",
    });
  });
  afterAll(() => h.cleanup());

  const run = async (q: string) =>
    (await (await h.fetch(`/api/admin/kpis/daily-total/run${q}`)).json()) as {
      data: { series: Array<{ t: number; value: number | null }> | null; point: { value: number } };
    };

  test("series is null unless asked for", async () => {
    const d = await run(`?to=${anchor}&rangeDays=4`);
    expect(d.data.series).toBeNull();
  });

  test("buckets cover the window, oldest first, in the right units", async () => {
    const d = await run(`?to=${anchor}&rangeDays=4&series=1&buckets=4`);
    const series = d.data.series!;
    expect(series.length).toBe(4);
    // Ascending, one day apart — a thousand-fold unit slip would show here.
    expect(series[1]!.t - series[0]!.t).toBe(DAY);
    expect(series[0]!.t).toBe(anchor - 4 * DAY);
    // The two oldest rows land in bucket 0, the newest in bucket 3.
    expect(series[0]!.value).toBe(10);
    expect(series[3]!.value).toBe(7);
    // …and the buckets sum to the headline figure.
    expect(series.reduce((a, s) => a + (s.value ?? 0), 0)).toBe(d.data.point.value);
  });

  test("an empty bucket is emitted as a real gap, not dropped", async () => {
    const d = await run(`?to=${anchor}&rangeDays=4&series=1&buckets=4`);
    const series = d.data.series!;
    // Nothing happened on days 2 and 3 of the window. For a `sum` that is a
    // genuine zero — and it must be PRESENT, or the line joins day 1 to day 4
    // and claims the gap never happened.
    expect(series[1]!.value).toBe(0);
    expect(series[2]!.value).toBe(0);
  });

  test("a KPI with no date column has no series to give", async () => {
    const res = await h.fetch(`/api/admin/kpis/no-date/run?series=1&buckets=4`);
    const body = (await res.json()) as { data: { series: unknown; window: unknown } };
    expect(body.data.window).toBeNull();
    expect(body.data.series).toBeNull();
  });
});
