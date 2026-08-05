/**
 * Postgres coverage for the KPI series buckets.
 *
 * The bucket index is the one piece of the KPI engine that branches on
 * dialect, and the branch is a unit conversion: SQLite keeps epoch
 * **milliseconds** in an INTEGER, Postgres keeps a `timestamptz` whose
 * `EXTRACT(EPOCH …)` comes back in **seconds** as a float. Get it wrong and
 * nothing errors — the series is bucketed a thousand times too coarse or too
 * fine, every row lands in bucket 0, and the sparkline is a plausible-looking
 * shape that is not the data. The SQLite suite cannot see that, so the same
 * fixture is asserted here.
 *
 * Follows `analytics-pg.test.ts`: pglite's WASM bundle is environment-
 * sensitive, so a harness that fails to boot degrades to a logged skip rather
 * than failing the whole suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";

const DAY = 86_400_000;
const JSON_HEADERS = { "Content-Type": "application/json" };

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;
const anchor = Date.now();
const slug = `pgseries_${anchor}`;

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      "[kpis-series-pg] harness setup failed — skipping pg path tests:",
      setupError.message,
    );
    return;
  }
  const post = (path: string, body: unknown) =>
    harness!.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-kpis-${anchor}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  await post("/api/collections", {
    slug,
    fields: [
      { name: "total", type: "integer" },
      { name: "at", type: "timestamp" },
    ],
  });
  // Same shape as the SQLite spec: two rows in the oldest day, one in the
  // newest, nothing in between.
  await post(`/api/items/${slug}`, { total: 5, at: new Date(anchor - 3.5 * DAY).toISOString() });
  await post(`/api/items/${slug}`, { total: 5, at: new Date(anchor - 3.2 * DAY).toISOString() });
  await post(`/api/items/${slug}`, { total: 7, at: new Date(anchor - 0.5 * DAY).toISOString() });
  await post("/api/admin/kpis", {
    slug: "pg-daily-total",
    name: "Daily total",
    collection: slug,
    agg: "sum",
    field: "total",
    dateField: "at",
  });
}, 60_000);

afterAll(async () => {
  await harness?.cleanup();
});

test("series buckets land in the right slices on Postgres", async () => {
  if (!harness) return;
  const res = await harness.fetch(
    `/api/admin/kpis/pg-daily-total/run?to=${anchor}&rangeDays=4&series=1&buckets=4`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { series: Array<{ t: number; value: number | null }>; point: { value: number } };
  };
  const series = body.data.series;
  expect(series.length).toBe(4);
  // One day apart. A seconds-vs-milliseconds slip would put every row in
  // bucket 0 (too coarse) or spread them past the cap (too fine).
  expect(series[1]!.t - series[0]!.t).toBe(DAY);
  expect(series[0]!.value).toBe(10);
  expect(series[1]!.value).toBe(0);
  expect(series[2]!.value).toBe(0);
  expect(series[3]!.value).toBe(7);
  // …and the buckets still add up to the headline number.
  expect(series.reduce((a, s) => a + (s.value ?? 0), 0)).toBe(Number(body.data.point.value));
}, 60_000);
