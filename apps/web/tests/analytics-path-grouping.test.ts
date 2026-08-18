/**
 * One page is one row, however many campaigns pointed at it.
 *
 * `analytics_events.path` deliberately keeps its query string — campaign tags
 * live there, and `?q=` / `?page=2` are real information a page report should
 * not discard. But GROUPING on it splits a single page into a row per variant,
 * which is what the first live traffic this feature ever collected actually
 * showed: `/live/1?utm_source=…` and `/live/2?utm_source=…` as separate pages.
 *
 * So a query-stripped `path_base` is materialized at write time and every page
 * report groups on that. These tests pin both halves: the grouping collapses,
 * and the full path is still there to be read.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  analyticsOverview,
  analyticsRealtime,
  analyticsSessions,
  getSiteById,
  pathWithoutQuery,
  recordEvents,
} from "../src/server/services/analytics";

const MIN = 60_000;
const T0 = Date.parse("2026-08-18T05:00:00.000Z");
const NOW = T0 + 6 * 60 * MIN;

let h: TestHarness;
let db: never;
let SITE = "";
let TENANT: string | null = null;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect } as never;

  const created = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Paths", domain: "paths.example" }),
  });
  SITE = ((await created.json()) as any).data.id;
  TENANT = (await getSiteById(db, SITE))!.tenantId;

  await recordEvents(
    db,
    TENANT,
    [
      // Same page, three different campaigns. One row in a page report.
      { name: "page_view", distinctId: "p1", siteId: SITE, path: "/pricing?utm_source=a&utm_medium=cpc", ts: T0 },
      { name: "page_view", distinctId: "p2", siteId: SITE, path: "/pricing?utm_source=b&utm_medium=email", ts: T0 + MIN },
      { name: "page_view", distinctId: "p3", siteId: SITE, path: "/pricing", ts: T0 + 2 * MIN },
      // A genuinely different page.
      { name: "page_view", distinctId: "p1", siteId: SITE, path: "/docs?page=2", ts: T0 + 3 * MIN },
    ],
    NOW,
  );
});

afterAll(() => h.cleanup());

test("the helper strips a query and leaves a bare path alone", () => {
  expect(pathWithoutQuery("/pricing?utm_source=a")).toBe("/pricing");
  expect(pathWithoutQuery("/pricing")).toBe("/pricing");
  expect(pathWithoutQuery("/")).toBe("/");
  // A path that is nothing but a query is not a page.
  expect(pathWithoutQuery("?a=1")).toBeNull();
  expect(pathWithoutQuery(null)).toBeNull();
});

test("top pages collapses campaign variants into one row", async () => {
  const o = await analyticsOverview(db, {
    tenantId: TENANT,
    from: T0 - MIN,
    to: NOW,
    siteId: SITE,
  } as never);

  const pricing = o.topPaths.filter((p) => p.path === "/pricing");
  expect(pricing.length).toBe(1);
  expect(pricing[0]!.count).toBe(3);
  expect(pricing[0]!.users).toBe(3);

  // …and nothing in the report still carries a query string.
  expect(o.topPaths.some((p) => p.path.includes("?"))).toBe(false);
  expect(o.topPaths.find((p) => p.path === "/docs")?.count).toBe(1);
});

test("the full path is still stored and readable", async () => {
  // Stripping is a REPORTING decision. `?page=2` and `?q=` are real, and the
  // raw-event view is where they have to survive.
  const res = await h.fetch("/api/admin/analytics/events?distinctId=p1&limit=5");
  const rows = ((await res.json()) as any).data as any[];
  const docs = rows.find((r) => r.pathBase === "/docs");
  expect(docs.path).toBe("/docs?page=2");
  expect(docs.pathBase).toBe("/docs");
});

test("landing and exit pages group the same way", async () => {
  const s = await analyticsSessions(db, {
    tenantId: TENANT,
    from: T0 - MIN,
    to: NOW,
    siteId: SITE,
  } as never);
  const all = [...s.landingPages, ...s.exitPages].map((r) => r.value);
  expect(all.length).toBeGreaterThan(0);
  expect(all.some((v) => v.includes("?"))).toBe(false);
});

test("realtime groups the same way", async () => {
  const rt = await analyticsRealtime(db, { tenantId: TENANT, siteId: SITE }, T0 + 4 * MIN);
  expect(rt.topPaths.length).toBeGreaterThan(0);
  expect(rt.topPaths.some((p) => p.value.includes("?"))).toBe(false);
  expect(rt.topPaths.find((p) => p.value === "/pricing")?.count).toBe(3);
});

test("campaign attribution is unaffected — the tags still parse", async () => {
  // The whole reason `path` keeps its query. Collapsing the page report must
  // not cost the campaign report.
  const o = await analyticsOverview(db, {
    tenantId: TENANT,
    from: T0 - MIN,
    to: NOW,
    siteId: SITE,
  } as never);
  const sources = o.topCampaigns.map((c) => c.value).sort();
  expect(sources).toEqual(["a", "b"]);
});
