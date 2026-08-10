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
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

const DAY = 86_400_000;
const STACK =
  "TypeError: boom\n  at doThing (/app/src/x.ts:12:9)\n  at main (/app/src/y.ts:3:1)";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;
const now = Date.now();

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      "[analytics-pg] harness setup failed — skipping pg path tests:",
      setupError.message,
    );
    return;
  }
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

/** Assert the sentinel when pglite couldn't boot, so bun-test still sees an
 *  expect() call and the run stays green (mirrors `pg-smoke.test.ts`). */
const skipped = (): boolean => {
  if (setupError || !harness) {
    expect(setupError).toBeDefined();
    return true;
  }
  return false;
};

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
