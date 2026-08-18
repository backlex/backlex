/**
 * Postgres coverage for the analytics analysis queries (#22).
 *
 * The funnel and retention SQL is the only place in the feature that branches
 * on dialect — Postgres binds `Date` against `timestamptz` and adds the funnel
 * window as an `interval`, SQLite binds epoch milliseconds and adds integers.
 * The SQLite suite can't catch a regression in the Postgres spelling, so this
 * spec asserts both dialects produce the same numbers from the same fixture.
 *
 * Follows `pg-smoke.test.ts`: pglite's WASM bundle is environment-sensitive, so
 * a harness that fails to boot degrades to a logged skip rather than failing
 * the whole suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

const DAY = 86_400_000;
const STACK =
  "TypeError: boom\n  at doThing (/app/src/x.ts:12:9)\n  at main (/app/src/y.ts:3:1)";

let harness: PgTestHarness | undefined;
const now = Date.now();

beforeAll(async () => {
  harness = (await makeHarnessPgOrFail("analytics-pg")) ?? undefined;
  if (!harness) return;
  const email = `pg-analytics-${Date.now()}@example.test`;
  const signUp = await harness.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "A" }),
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  // Same fixture the SQLite spec uses: three visitors enter and sign up, two
  // purchase the next day, one returns two days on.
  const events: unknown[] = [];
  for (const [i, u] of ["f1", "f2", "f3"].entries()) {
    events.push({
      name: "page_view",
      distinctId: u,
      sessionId: `sess-${i}`,
      path: "/pricing",
      source: "web",
      ts: now - 5 * DAY,
    });
    events.push({ name: "signup", distinctId: u, ts: now - 5 * DAY + 1000 });
  }
  events.push({ name: "purchase", distinctId: "f1", ts: now - 4 * DAY });
  events.push({ name: "purchase", distinctId: "f2", ts: now - 4 * DAY });
  events.push({ name: "page_view", distinctId: "f3", ts: now - 3 * DAY });
  const ingest = await harness.fetch("/api/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (ingest.status !== 202) throw new Error(`ingest failed: ${ingest.status}`);
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
}, PGLITE_BOOT_TIMEOUT_MS);

/** Only reachable under `BACKLEX_PG_TESTS=optional` — otherwise a harness that
 *  cannot boot has already failed the run in `beforeAll`. */
const skipped = (): boolean => !harness;

test("pg: overview counts and zero-fills like sqlite", async () => {
  if (skipped()) return;
  const res = await harness!.fetch(
    `/api/admin/analytics/overview?from=${now - 7 * DAY}&to=${now}`,
  );
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as any;
  expect(data.totals.events).toBe(9);
  expect(data.totals.users).toBe(3);
  expect(data.totals.sessions).toBe(3);
  expect(data.series.length).toBe(8);
  expect(data.topEvents.find((e: any) => e.name === "page_view").count).toBe(4);
  expect(data.topPaths[0].path).toBe("/pricing");

  // The cookieless-aware counters ride on the same round-trip via
  // `count(distinct case when ...)` / `sum(case when ...)`. Postgres and
  // SQLite spell those identically, and this is what proves it rather than
  // assuming it.
  expect(data.totals.durableUsers).toBe(3);
  expect(data.totals.cookielessShare).toBe(0);
  expect(data.totals.visitorsPerDay).toBeNull();
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: breakdowns carry distinct users, not just row counts", async () => {
  if (skipped()) return;
  const res = await harness!.fetch(
    `/api/admin/analytics/overview?from=${now - 7 * DAY}&to=${now}`,
  );
  const { data } = (await res.json()) as any;

  // `count(distinct ...)` inside a grouped breakdown is the addition phase 1
  // makes to `topBy`. The fixture's three visitors all hit /pricing once at
  // entry, so hits and people agree there — what is being pinned is that
  // Postgres returns the column at all and that it is a number, not a string
  // (pg returns bigint counts as strings through some drivers, which would
  // make `users` render as "3").
  const pricing = data.topPaths.find((r: any) => r.path === "/pricing");
  expect(pricing.count).toBe(3);
  const sources = data.topCountries.concat(data.topDevices, data.topCampaigns);
  for (const row of sources) {
    expect(typeof row.count).toBe("number");
    expect(typeof row.users).toBe("number");
  }
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: LAG + SUM OVER sessionize with the interval spelling", async () => {
  if (skipped()) return;
  // The Postgres twin of `analytics-sessionization-probe.test.ts`. This is the
  // phase-4 unblocker: the gap comparison is the ONE place sessionization
  // touches the dialect, and it does so through the same `interval` spelling
  // `windowSql` already uses. If this passes, phase 4 adds no new dialect
  // branch — and if it fails, we learn now rather than three phases in.
  const { buildContext } = await import("../src/server/context");
  const ctx = await buildContext(harness!.env);
  const { sql } = await import("drizzle-orm");

  const GAP_MS = 30 * 60_000;
  const query = sql`
    WITH lagged AS (
      SELECT distinct_id, ts,
             LAG(ts) OVER (PARTITION BY distinct_id, day ORDER BY ts) AS prev_ts
      FROM analytics_events
    ),
    marked AS (
      SELECT distinct_id, ts,
             CASE WHEN prev_ts IS NULL
                       OR ${sql.raw(`prev_ts + interval '${GAP_MS} milliseconds' < ts`)}
                  THEN 1 ELSE 0 END AS is_new
      FROM lagged
    )
    SELECT SUM(is_new) AS sessions FROM marked`;

  const rows = ((await (ctx.db as any).execute(query)) as any).rows as any[];
  // 9 events collapse to 6 sessions, and the arithmetic is what does it. Each
  // of the three visitors fires page_view + signup ONE SECOND apart on the
  // same day — well inside the 30-minute gap, so those pair into one session —
  // then returns on a later day, which opens a second. 3 × 2 = 6.
  //
  // This is the assertion that actually exercises the `interval` spelling: a
  // broken one either treats the 1-second pairs as separate sessions (→ 9) or
  // swallows the day boundary (→ 3).
  expect(Number(rows[0]?.sessions)).toBe(6);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: the funnel interval window matches the sqlite integer window", async () => {
  if (skipped()) return;
  const res = await harness!.fetch("/api/admin/analytics/funnel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      steps: ["page_view", "signup", "purchase"],
      windowDays: 7,
      from: now - 7 * DAY,
      to: now,
    }),
  });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as any;
  expect(data.steps.map((s: any) => s.count)).toEqual([3, 3, 2]);
  expect(data.steps[2].conversion).toBeCloseTo(2 / 3, 5);

  // f3's return page_view is 2 days after its signup, so the window boundary
  // decides whether it converts. This is what actually exercises the `interval`
  // arithmetic — a broken Postgres spelling shifts one of these two numbers.
  const windowed = async (windowDays: number) => {
    const res = await harness!.fetch("/api/admin/analytics/funnel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: ["signup", "page_view"],
        windowDays,
        from: now - 7 * DAY,
        to: now,
      }),
    });
    return ((await res.json()) as any).data.steps[1].count;
  };
  expect(await windowed(1)).toBe(0);
  expect(await windowed(7)).toBe(1);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: retention cohorts key on the first-ever day", async () => {
  if (skipped()) return;
  const res = await harness!.fetch("/api/admin/analytics/retention", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: now - 7 * DAY, to: now }),
  });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as any;
  const cohort = data.cohorts.find((c: any) => c.size === 3);
  expect(cohort).toBeDefined();
  expect(cohort.values[1]).toBe(2);
  expect(cohort.values[2]).toBe(1);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: error groups fold, reopen and delete", async () => {
  if (skipped()) return;
  const report = await harness!.fetch("/api/analytics/errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      errors: [
        { message: "pg boom 1", type: "TypeError", stack: STACK, distinctId: "e1" },
        { message: "pg boom 2", type: "TypeError", stack: STACK, distinctId: "e2" },
      ],
    }),
  });
  expect(report.status).toBe(202);
  const body = (await report.json()) as { accepted: number; groups: string[] };
  // Both messages normalize to "pg boom <n>" — one group, two occurrences.
  expect(body.groups.length).toBe(1);
  const id = body.groups[0]!;

  const detail = await harness!.fetch(`/api/admin/analytics/errors/${id}`);
  const d = ((await detail.json()) as any).data;
  expect(d.group.events).toBe(2);
  expect(d.users).toBe(2);

  await harness!.fetch(`/api/admin/analytics/errors/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolved" }),
  });
  await harness!.fetch("/api/analytics/errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      errors: [{ message: "pg boom 3", type: "TypeError", stack: STACK }],
    }),
  });
  const after = await harness!.fetch(`/api/admin/analytics/errors/${id}`);
  expect(((await after.json()) as any).data.group.status).toBe("open");

  const del = await harness!.fetch(`/api/admin/analytics/errors/${id}`, {
    method: "DELETE",
  });
  expect(del.status).toBe(200);
}, PGLITE_TEST_TIMEOUT_MS);
