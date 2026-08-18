/**
 * The realtime view — "who is on the site right now".
 *
 * The interesting parts are the boundaries, because a realtime chart that is
 * subtly wrong still looks alive:
 *
 *  - the window is exactly 30 minutes, so an event just outside it must not
 *    appear (and one just inside must);
 *  - buckets are anchored to a whole minute, so two polls a few seconds apart
 *    return the SAME boundaries rather than a shimmering chart;
 *  - the series is always 30 points, zero-filled — a quiet minute is a zero,
 *    not a missing point that shortens the axis;
 *  - `truncated` exists because a row cap silently clipping "visitors now"
 *    would be a wrong number that renders perfectly.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  REALTIME_MINUTES,
  analyticsRealtime,
  recordEvents,
} from "../src/server/services/analytics";

const MIN = 60_000;
let h: TestHarness;
let db: { db: unknown; dialect: "pg" | "sqlite" };

/** A whole-minute anchor keeps the fixture's offsets exact. */
const NOW = Math.floor(Date.parse("2026-08-18T12:00:00.000Z") / MIN) * MIN;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect };

  await recordEvents(
    db as never,
    null,
    [
      // Inside the window.
      { name: "page_view", distinctId: "r1", path: "/now", referrer: "https://news.test/", country: "TR", ts: NOW - 1 * MIN },
      { name: "page_view", distinctId: "r1", path: "/now", ts: NOW - 2 * MIN },
      { name: "page_view", distinctId: "r2", path: "/other", country: "TR", ts: NOW - 5 * MIN },
      // Just inside the 30-minute edge.
      { name: "page_view", distinctId: "r3", path: "/edge", ts: NOW - 29 * MIN },
      // Comfortably outside it.
      { name: "page_view", distinctId: "r4", path: "/stale", ts: NOW - 90 * MIN },
    ],
    NOW + MIN,
  );
});

afterAll(() => h.cleanup());

test("the window holds exactly the last 30 minutes", async () => {
  const rt = await analyticsRealtime(db as never, { tenantId: null }, NOW);

  // r1 (×2), r2, r3 are in; r4 at −90min is not.
  expect(rt.events).toBe(4);
  expect(rt.visitorsNow).toBe(3);
  expect(rt.topPaths.map((p) => p.value).sort()).toEqual(["/edge", "/now", "/other"]);
  expect(rt.topPaths.find((p) => p.value === "/now")).toEqual({
    value: "/now",
    count: 2,
    users: 1,
  });
  expect(rt.truncated).toBe(false);
});

test("the series is always 30 zero-filled points, oldest first", async () => {
  const rt = await analyticsRealtime(db as never, { tenantId: null }, NOW);
  expect(rt.byMinute.length).toBe(REALTIME_MINUTES);

  // Strictly increasing, exactly one minute apart — a gap would let a chart
  // draw two adjacent minutes as neighbours when they are not.
  for (let i = 1; i < rt.byMinute.length; i++) {
    expect(rt.byMinute[i]!.minute - rt.byMinute[i - 1]!.minute).toBe(MIN);
  }
  // Quiet minutes are present as zeros rather than absent.
  expect(rt.byMinute.some((b) => b.events === 0)).toBe(true);
  expect(rt.byMinute.reduce((n, b) => n + b.events, 0)).toBe(4);
});

test("buckets are anchored to a whole minute, so polling does not shift them", async () => {
  // Two calls a few seconds apart inside the same minute must agree, or the
  // chart re-buckets on every 10-second poll and appears to jitter.
  const a = await analyticsRealtime(db as never, { tenantId: null }, NOW + 3_000);
  const b = await analyticsRealtime(db as never, { tenantId: null }, NOW + 41_000);
  expect(a.byMinute.map((x) => x.minute)).toEqual(b.byMinute.map((x) => x.minute));
});

test("it can be scoped to one registered site", async () => {
  await recordEvents(
    db as never,
    null,
    [{ name: "page_view", distinctId: "s1", path: "/sited", siteId: "site-abc", ts: NOW - 3 * MIN }],
    NOW + MIN,
  );

  const scoped = await analyticsRealtime(
    db as never,
    { tenantId: null, siteId: "site-abc" },
    NOW,
  );
  expect(scoped.events).toBe(1);
  expect(scoped.topPaths[0]?.value).toBe("/sited");

  // Unscoped still sees everything.
  const all = await analyticsRealtime(db as never, { tenantId: null }, NOW);
  expect(all.events).toBe(5);
});

test("the REST surface is admin-only and returns the same shape", async () => {
  const res = await h.fetch("/api/admin/analytics/realtime");
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as any;
  expect(data.byMinute.length).toBe(REALTIME_MINUTES);
  expect(typeof data.visitorsNow).toBe("number");
  expect(data.truncated).toBe(false);

  const anon = makeHarness();
  try {
    expect((await anon.fetch("/api/admin/analytics/realtime")).status).toBe(401);
  } finally {
    anon.cleanup();
  }
});
