/**
 * Metrics overview endpoint (`GET /api/admin/metrics/overview`).
 *
 * Regression test: `recentErrors` used to iterate the full 5000-row activity
 * fetch without applying the `range` window, so the panel would list errors
 * from days ago even when the header said "last 1h · 0 events". The fix added
 * the same `ts < start` filter the totals/series loops use — this suite
 * pins it down by seeding errors both inside and outside the window.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const HOUR = 60 * 60 * 1000;

const sqlEscape = (s: string) => s.replace(/'/g, "''");

const insertErrorRow = (
  h: TestHarness,
  row: { id: string; action: string; collection: string; createdAt: number; code: string },
) =>
  h.fetch("/api/admin/db/sql/run?writes=1", {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
    body: JSON.stringify({
      sql:
        "INSERT INTO activity (id, action, collection, payload, created_at) VALUES (" +
        `'${sqlEscape(row.id)}', ` +
        `'${sqlEscape(row.action)}', ` +
        `'${sqlEscape(row.collection)}', ` +
        `'${sqlEscape(JSON.stringify({ code: row.code, error: `${row.action} failed`, message: `${row.action} failed` }))}', ` +
        `${row.createdAt})`,
    }),
  });

/** Plain (non-error) activity row — counts toward `totals.requests` only. */
const insertActivityRow = (
  h: TestHarness,
  row: { id: string; action: string; collection: string; createdAt: number },
) =>
  h.fetch("/api/admin/db/sql/run?writes=1", {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
    body: JSON.stringify({
      sql:
        "INSERT INTO activity (id, action, collection, created_at) VALUES (" +
        `'${sqlEscape(row.id)}', ` +
        `'${sqlEscape(row.action)}', ` +
        `'${sqlEscape(row.collection)}', ` +
        `${row.createdAt})`,
    }),
  });

/**
 * Real user + its session — drives `totals.activeUsers` (distinct user_id whose
 * session `created_at` falls in the window). `sessions.user_id` has an enforced
 * FK to `users`, so we seed the user row (id = userId) in the same batch.
 */
const insertSession = (
  h: TestHarness,
  row: { id: string; userId: string; createdAt: number },
) =>
  h.fetch("/api/admin/db/sql/run?writes=1", {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
    body: JSON.stringify({
      sql:
        "INSERT INTO users (id, email, created_at, updated_at) VALUES (" +
        `'${sqlEscape(row.userId)}', '${sqlEscape(`${row.userId}@example.test`)}', ${row.createdAt}, ${row.createdAt}); ` +
        "INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (" +
        `'${sqlEscape(row.id)}', ` +
        `'${sqlEscape(row.userId)}', ` +
        `'${sqlEscape(`tok-${row.id}`)}', ` +
        `${row.createdAt + 7 * 24 * HOUR}, ` +
        `${row.createdAt}, ` +
        `${row.createdAt})`,
    }),
  });

interface OverviewResponse {
  data: {
    range: string;
    totals: { errors: number; requests: number; activeUsers: number };
    recentErrors: { code: string; resource: string; count: number; last: number }[];
  };
}

describe("metrics overview: recentErrors respects the range window", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const now = Date.now();
    // Inside the 1h window (~30 minutes ago) — should show up.
    for (let i = 0; i < 3; i++) {
      const r = await insertErrorRow(h, {
        id: `recent-${i}`,
        action: "function.invoke",
        collection: "system_functions",
        createdAt: now - 30 * 60 * 1000,
        code: "RECENT_ERR",
      });
      expect(r.status).toBe(200);
    }
    // Outside the 1h window (~5 hours ago) — must NOT show up at range=1h.
    for (let i = 0; i < 4; i++) {
      const r = await insertErrorRow(h, {
        id: `old-${i}`,
        action: "flow.run",
        collection: "system_flows",
        createdAt: now - 5 * HOUR,
        code: "OLD_ERR",
      });
      expect(r.status).toBe(200);
    }
  });

  afterAll(() => h.cleanup());

  test("range=1h excludes errors older than the window", async () => {
    const res = await h.fetch("/api/admin/metrics/overview?range=1h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;

    const codes = body.data.recentErrors.map((e) => e.code);
    expect(codes).toContain("RECENT_ERR");
    expect(codes).not.toContain("OLD_ERR");

    // Counts in the panel should also match the window — the recent bucket
    // had 3 rows; the old bucket's 4 rows must not bleed into it.
    const recent = body.data.recentErrors.find((e) => e.code === "RECENT_ERR");
    expect(recent?.count).toBe(3);

    // And the header total stays consistent with the panel.
    expect(body.data.totals.errors).toBe(3);
  });

  test("range=24h includes the older errors", async () => {
    const res = await h.fetch("/api/admin/metrics/overview?range=24h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;

    const codes = body.data.recentErrors.map((e) => e.code);
    expect(codes).toContain("RECENT_ERR");
    expect(codes).toContain("OLD_ERR");
    expect(body.data.totals.errors).toBe(7);
  });
});

/**
 * The activity + sessions queries now apply the `created_at >= start` window
 * bound in SQL (instead of fetching a 5000/2000-row cap and filtering in JS).
 * These suites pin the window semantics so the SQL bound can't drift from the
 * old app-side behavior — and cover the previously-untested sessions path that
 * backs `totals.activeUsers` (now served by `sessions_created_idx`).
 */
describe("metrics overview: totals.requests respects the range window", () => {
  let h: TestHarness;
  /**
   * How many rows the SEEDING itself added, at `now`.
   *
   * `insertActivityRow` writes through `POST /api/admin/db/sql/run`, and that
   * endpoint now writes its own `db.sql` activity row — running arbitrary SQL
   * is a privileged act and used to leave no trace, which is what the 2026-09
   * audit's phase 10 filed. Those rows are stamped `now`, so they land inside
   * BOTH windows. Counted rather than hardcoded so the intent stays legible: the
   * assertions below are about the seeded rows, plus whatever the seeding cost.
   */
  let seedingRows = 0;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const now = Date.now();
    // 5 rows inside the 1h window (~20 min ago).
    for (let i = 0; i < 5; i++) {
      const r = await insertActivityRow(h, {
        id: `req-in-${i}`,
        action: "item.read",
        collection: "widgets",
        createdAt: now - 20 * 60 * 1000,
      });
      expect(r.status).toBe(200);
      seedingRows++;
    }
    // 4 rows outside the 1h window (~6h ago) — must not leak into range=1h.
    for (let i = 0; i < 4; i++) {
      const r = await insertActivityRow(h, {
        id: `req-out-${i}`,
        action: "item.read",
        collection: "widgets",
        createdAt: now - 6 * HOUR,
      });
      expect(r.status).toBe(200);
      seedingRows++;
    }
  });

  afterAll(() => h.cleanup());

  test("range=1h counts only in-window requests", async () => {
    const res = await h.fetch("/api/admin/metrics/overview?range=1h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.data.totals.requests).toBe(5 + seedingRows);
  });

  test("range=24h includes the older requests", async () => {
    const res = await h.fetch("/api/admin/metrics/overview?range=24h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.data.totals.requests).toBe(9 + seedingRows);
  });
});

describe("metrics overview: totals.activeUsers respects the range window", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const now = Date.now();
    // 3 distinct users signed in inside the 1h window (~15 min ago).
    for (let i = 0; i < 3; i++) {
      const r = await insertSession(h, {
        id: `sess-in-${i}`,
        userId: `user-in-${i}`,
        createdAt: now - 15 * 60 * 1000,
      });
      expect(r.status).toBe(200);
    }
    // 2 distinct users outside the window (~8h ago) — excluded at range=1h.
    for (let i = 0; i < 2; i++) {
      const r = await insertSession(h, {
        id: `sess-out-${i}`,
        userId: `user-out-${i}`,
        createdAt: now - 8 * HOUR,
      });
      expect(r.status).toBe(200);
    }
  });

  afterAll(() => h.cleanup());

  test("range=1h counts only users with an in-window session", async () => {
    const res = await h.fetch("/api/admin/metrics/overview?range=1h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    // 3 seeded in-window users; the admin's own sign-in session (from seedAdmin)
    // also lands in-window, so assert the seeded users are all counted.
    expect(body.data.totals.activeUsers).toBeGreaterThanOrEqual(3);
  });

  test("range=24h additionally counts the older sessions' users", async () => {
    const range1h = (await (await h.fetch("/api/admin/metrics/overview?range=1h")).json()) as OverviewResponse;
    const range24h = (await (await h.fetch("/api/admin/metrics/overview?range=24h")).json()) as OverviewResponse;
    // The 2 out-of-window users appear only once the window widens to 24h.
    expect(range24h.data.totals.activeUsers).toBe(range1h.data.totals.activeUsers + 2);
  });
});
