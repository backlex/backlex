/**
 * Sessions, derived at query time.
 *
 * There is no sessions table: a window function reconstructs boundaries from
 * the events already stored. Every number below is one a stakeholder reads
 * directly — bounce rate, average duration, pages per session — so the fixture
 * is built so each has exactly one right answer, worked out by hand:
 *
 *   v1  /a, /b, /c at 0, +5, +10 min   → one session, 3 hits, 10 min long
 *   v1  /d at +41 min (31 after /c)    → a SECOND session, 1 hit, 0 long
 *   v2  /x once                        → one session, 1 hit, a bounce
 *   v3  /p, /q 10 min apart            → one session, 2 hits, 10 min long
 *   srv a server-side event, no site   → excluded entirely
 *
 * ⇒ 4 sessions, 7 pageviews, 2 bounces (50%), 20 minutes of total duration
 *   over 4 sessions = 5 minutes average, 1.75 pages per session.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  analyticsSessions,
  getSiteById,
  recordEvents,
} from "../src/server/services/analytics";

const MIN = 60_000;

let h: TestHarness;
let db: never;
/** Created through the API so it lands under the admin's workspace — the REST
 *  route reads `auth.tenantId`, so a fixture written under NULL would be
 *  invisible to it and the route would look broken when it is not. */
let SITE = "";
let TENANT: string | null = null;

/** Fixed and in the past: `recordEvents` clamps a `ts` more than 5 minutes
 *  ahead of the `now` it is given, which would silently collapse the fixture
 *  onto one instant and read exactly like a broken window function. */
const T0 = Date.parse("2026-08-18T09:00:00.000Z");
const NOW = T0 + 6 * 60 * MIN;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect } as never;

  const created = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Sessions", domain: "sessions.example" }),
  });
  if (created.status !== 201) throw new Error(`site create failed: ${created.status}`);
  SITE = ((await created.json()) as any).data.id;
  TENANT = (await getSiteById(db, SITE))!.tenantId;

  await recordEvents(
    db,
    TENANT,
    [
      { name: "page_view", distinctId: "v1", siteId: SITE, path: "/a", ts: T0 },
      { name: "page_view", distinctId: "v1", siteId: SITE, path: "/b", ts: T0 + 5 * MIN },
      { name: "page_view", distinctId: "v1", siteId: SITE, path: "/c", ts: T0 + 10 * MIN },
      // 31 minutes after /c — past the 30-minute gap, so a new session.
      { name: "page_view", distinctId: "v1", siteId: SITE, path: "/d", ts: T0 + 41 * MIN },
      { name: "page_view", distinctId: "v2", siteId: SITE, path: "/x", ts: T0 + 2 * MIN },
      { name: "page_view", distinctId: "v3", siteId: SITE, path: "/p", ts: T0 + 3 * MIN },
      { name: "page_view", distinctId: "v3", siteId: SITE, path: "/q", ts: T0 + 13 * MIN },
      // No siteId: a server-side SDK event. It is not a visit and must not
      // appear in any figure here.
      { name: "cron_ran", distinctId: "srv", path: "/internal", ts: T0 + 4 * MIN },
    ],
    NOW,
  );
});

afterAll(() => h.cleanup());

const run = () =>
  analyticsSessions(db, { tenantId: TENANT, from: T0 - MIN, to: NOW, siteId: SITE });

test("a 30-minute gap ends a session; a shorter one does not", async () => {
  const s = await run();
  // v1 splits 3 + 1; v2 and v3 are one each.
  expect(s.sessions).toBe(4);
  expect(s.pageviews).toBe(7);
});

test("bounce rate counts single-pageview sessions", async () => {
  const s = await run();
  // v1's second session (/d alone) and v2's only session.
  expect(s.bounceRate).toBeCloseTo(0.5, 5);
  expect(s.pagesPerSession).toBeCloseTo(1.75, 5);
});

test("average duration includes bounces as zero rather than dropping them", async () => {
  const s = await run();
  // 10 + 0 + 0 + 10 minutes over 4 sessions. Dropping the zero-length ones
  // would report 10 minutes and flatter the number by 2x.
  expect(s.avgDurationMs).toBe(5 * MIN);
});

test("landing and exit pages are the session's first and last, not the same page", async () => {
  const s = await run();
  const landing = s.landingPages.map((r) => r.value).sort();
  const exits = s.exitPages.map((r) => r.value).sort();

  expect(landing).toEqual(["/a", "/d", "/p", "/x"]);
  // The one that catches a missing window frame: without an explicit
  // `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`, LAST_VALUE
  // returns the CURRENT row and the exit report silently becomes the landing
  // report — /c and /q would come back as /a and /p.
  expect(exits).toEqual(["/c", "/d", "/q", "/x"]);
  expect(exits).not.toEqual(landing);
});

test("server-side events are not visits", async () => {
  const s = await run();
  const all = [...s.landingPages, ...s.exitPages].map((r) => r.value);
  expect(all).not.toContain("/internal");

  // Unscoped by site, the server event is still excluded — `site_id IS NOT
  // NULL` is what does it, not the site filter.
  const unscoped = await analyticsSessions(db, {
    tenantId: TENANT,
    from: T0 - MIN,
    to: NOW,
  });
  expect(unscoped.sessions).toBe(4);
  expect(unscoped.pageviews).toBe(7);
});

test("an empty window returns zeros, not NaN", async () => {
  // SUM over no rows is NULL in both dialects; dividing by a zero session
  // count is how a report starts rendering "NaN%".
  const empty = await analyticsSessions(db, {
    tenantId: TENANT,
    from: T0 - 40 * 24 * 60 * MIN,
    to: T0 - 30 * 24 * 60 * MIN,
    siteId: SITE,
  });
  expect(empty.sessions).toBe(0);
  expect(empty.bounceRate).toBe(0);
  expect(empty.avgDurationMs).toBe(0);
  expect(empty.pagesPerSession).toBe(0);
  expect(empty.landingPages).toEqual([]);
});

test("the REST surface is admin-only and matches the service", async () => {
  const res = await h.fetch(
    `/api/admin/analytics/sessions?from=${T0 - MIN}&to=${NOW}&siteId=${SITE}`,
  );
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as any;
  expect(data.sessions).toBe(4);
  expect(data.bounceRate).toBeCloseTo(0.5, 5);

  const anon = makeHarness();
  try {
    expect((await anon.fetch("/api/admin/analytics/sessions")).status).toBe(401);
  } finally {
    anon.cleanup();
  }
});
