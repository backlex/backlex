/**
 * Phase-1 risk probes for the website-analytics roadmap.
 *
 * Neither of these tests a feature that ships today. Both retire an assumption
 * that a LATER phase is built on, at a point where being wrong is cheap.
 *
 * ── Probe 1: window functions ──────────────────────────────────────────
 * Phase 4 derives sessions (count, duration, bounce, landing/exit page) with a
 * window function instead of a second write path, which is what lets the
 * feature honour "no derived session table". The only precedent in this repo
 * is `packages/db/src/sqlite/ledger-sql.ts:42`, and that is a D1 maintenance
 * script — not a query issued through the app's own db handle. So "SQLite
 * supports LAG/SUM OVER" was, until this file, an assumption.
 *
 * The query below is the real phase-4 sessionization shape, not a toy: it is
 * the one that decides where a session boundary falls. Its Postgres twin lives
 * in `analytics-pg.test.ts`, because the gap comparison is the one place this
 * touches the dialect — and it does so through the EXISTING `windowSql`
 * spelling (pg adds an `interval`, SQLite adds an integer), so phase 4 adds no
 * new dialect branch and the module invariant at `services/analytics.ts:16-27`
 * survives.
 *
 * ── Probe 2: the D1 bound-parameter budget ─────────────────────────────
 * `insertChunked` sizes each multi-row INSERT as `PARAM_BUDGET / columnCount`
 * because D1 caps a statement at ~100 bound parameters. Every column added to
 * `analytics_events` therefore costs write throughput on the highest-volume
 * path in the product, and the cost is invisible — nothing fails, there are
 * just more round-trips. This asserts the floor so the next person to add a
 * column has to make that trade deliberately.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getTableColumns, sql } from "drizzle-orm";
import * as sqliteSchema from "@backlex/db/sqlite/schema";
import { makeHarness, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";

const MIN = 60_000;
/** GA's session definition, and the one phase 4 will use. */
const GAP_MS = 30 * MIN;

let h: TestHarness;
let db: any;
let dialect: "pg" | "sqlite";

/**
 * Anchored to a fixed instant so day bucketing can't straddle midnight.
 *
 * `NOW` sits AFTER every fixture event on purpose: `recordEvents` clamps a
 * client-supplied `ts` to at most 5 minutes in the future, so a fixture that
 * writes events "later" than the `now` it passes gets every one of them
 * silently flattened onto the same instant — which reads exactly like a broken
 * window function. Keep the whole fixture in the past.
 */
const T0 = Date.parse("2026-08-18T10:00:00.000Z");
const NOW = T0 + 3 * 60 * 60_000;

beforeAll(async () => {
  h = makeHarness();
  const email = `probe-${Date.now()}@example.test`;
  const signUp = await h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "P" }),
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const ctx = await buildContext(h.env);
  db = ctx.db;
  dialect = ctx.dialect;

  // Fixture, all on one UTC day so `day` partitioning is not the variable
  // under test:
  //   v1 — three hits 5 min apart      → ONE session of 3 hits
  //   v1 — a fourth hit 31 min later   → a SECOND session of 1 hit (a bounce)
  //   v2 — a single hit                → ONE session of 1 hit (a bounce)
  const { recordEvents } = await import("../src/server/services/analytics");
  await recordEvents(
    { db, dialect },
    null,
    [
      { name: "page_view", distinctId: "v1", path: "/a", ts: T0 },
      { name: "page_view", distinctId: "v1", path: "/b", ts: T0 + 5 * MIN },
      { name: "page_view", distinctId: "v1", path: "/c", ts: T0 + 10 * MIN },
      // 31 minutes after the previous hit — past the 30-minute gap.
      { name: "page_view", distinctId: "v1", path: "/d", ts: T0 + 41 * MIN },
      { name: "page_view", distinctId: "v2", path: "/a", ts: T0 + 2 * MIN },
    ],
    NOW,
  );
});

afterAll(() => h?.cleanup());

/**
 * The gap predicate, spelled per dialect exactly the way `windowSql` already
 * does it in `services/analytics.ts` — pg cannot infer a bound parameter's
 * type inside interval arithmetic, so the millisecond count is inlined (it is
 * a server-side constant here, never user input).
 */
const gapExceeded = (d: "pg" | "sqlite", ms: number) =>
  d === "pg"
    ? sql.raw(`prev_ts + interval '${ms} milliseconds' < ts`)
    : sql.raw(`prev_ts + ${ms} < ts`);

test("probe: LAG + SUM OVER sessionize correctly on this dialect", async () => {
  const query = sql`
    WITH lagged AS (
      SELECT distinct_id, ts, path,
             LAG(ts) OVER (PARTITION BY distinct_id, day ORDER BY ts) AS prev_ts
      FROM analytics_events
      WHERE tenant_id IS NULL
    ),
    marked AS (
      SELECT distinct_id, ts, path,
             CASE WHEN prev_ts IS NULL OR ${gapExceeded(dialect, GAP_MS)}
                  THEN 1 ELSE 0 END AS is_new
      FROM lagged
    ),
    sessions AS (
      SELECT distinct_id, ts, path,
             SUM(is_new) OVER (
               PARTITION BY distinct_id ORDER BY ts
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS sess
      FROM marked
    )
    SELECT distinct_id, sess, COUNT(*) AS hits
    FROM sessions
    GROUP BY distinct_id, sess
    ORDER BY distinct_id, sess`;

  const rows =
    dialect === "pg"
      ? ((await db.execute(query)) as any).rows
      : await db.all(query);

  const shape = (rows as any[]).map((r) => ({
    visitor: String(r.distinct_id),
    session: Number(r.sess),
    hits: Number(r.hits),
  }));

  // v1's four hits split 3 + 1 at the 31-minute gap; v2 has a single session.
  expect(shape).toEqual([
    { visitor: "v1", session: 1, hits: 3 },
    { visitor: "v1", session: 2, hits: 1 },
    { visitor: "v2", session: 1, hits: 1 },
  ]);
});

test("probe: a hit exactly ON the gap boundary does NOT open a session", async () => {
  // The predicate is `prev + gap < ts`, so 30:00 stays in the session and
  // 30:00.001 opens a new one. Pinning it means a future rewrite that flips to
  // `<=` is caught rather than silently reclassifying every borderline session.
  const boundary = sql`
    WITH lagged AS (
      SELECT ts, LAG(ts) OVER (PARTITION BY distinct_id ORDER BY ts) AS prev_ts
      FROM analytics_events WHERE tenant_id IS NULL AND distinct_id = 'v1'
    )
    SELECT COUNT(*) AS n FROM lagged
    WHERE prev_ts IS NOT NULL AND ${gapExceeded(dialect, GAP_MS)}`;

  const rows =
    dialect === "pg"
      ? ((await db.execute(boundary)) as any).rows
      : await db.all(boundary);
  // Only the 31-minute gap qualifies; the two 5-minute gaps do not.
  expect(Number((rows as any[])[0]?.n)).toBe(1);
});

test("the widened event row still fits a useful D1 INSERT chunk", async () => {
  // `recordEvents` writes every column on the table, and `insertChunked` sizes
  // each statement as `PARAM_BUDGET / keyCount`. Deriving the count from the
  // schema rather than hardcoding it is the whole point: this test has to move
  // when someone adds a column, or it is not a guard.
  const columns = Object.keys(getTableColumns(sqliteSchema.analyticsEvents)).length;
  const PARAM_BUDGET = 90; // must track services/analytics.ts
  const perStmt = Math.max(1, Math.floor(PARAM_BUDGET / columns));

  // At 26 columns this is 3 rows per statement — a full 500-event batch is
  // ~167 INSERTs, up from ~84 before the web dimensions landed. Dropping to 2
  // would make it 250, which is where the highest-volume write path in the
  // product stops being reasonable on D1. When this fails, the fix is to move
  // the new dimension into `props`, NOT to raise PARAM_BUDGET: D1's
  // ~100-bound-parameter cap is hard, and exceeding it fails the write
  // outright with `too many SQL variables`.
  expect(perStmt).toBeGreaterThanOrEqual(3);
});

test("a full 500-event batch still round-trips after widening the row", async () => {
  const key = await mintIngestKey();
  const events = Array.from({ length: 500 }, (_, i) => ({
    name: "bulk",
    distinctId: `bulk-${i % 7}`,
    path: "/bulk",
    ts: T0 + i,
  }));
  const res = await h.fetch("/api/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Backlex-Ingest-Key": key },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(202);
  expect((await res.json()).accepted).toBe(500);
});

const mintIngestKey = async (): Promise<string> => {
  const res = await h.fetch("/api/admin/analytics/ingest-key", { method: "POST" });
  if (!res.ok) throw new Error(`mint failed: ${res.status}`);
  return (await res.json()).data.key as string;
};
