/**
 * Revenue reporting.
 *
 * Two failure modes drive this spec, and neither shows up on a happy path:
 *
 *  1. **Summing across currencies.** There is no FX source in this repo, so
 *     100 TRY + 100 EUR is not 200 of anything. Every row carries its own
 *     currency so the mistake is unavailable rather than merely discouraged.
 *  2. **A malformed `props` blob.** It is caller-supplied and can also arrive
 *     from a tool writing straight to the table. One bad row must not 500 a
 *     revenue report for the whole workspace.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  analyticsRevenue,
  getSiteById,
  recordEvents,
} from "../src/server/services/analytics";

const MIN = 60_000;
const T0 = Date.parse("2026-08-18T07:00:00.000Z");
const NOW = T0 + 6 * 60 * MIN;

let h: TestHarness;
let db: never;
let rawDb: any;
let SITE = "";
let TENANT: string | null = null;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect } as never;
  rawDb = ctx.db;

  const created = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Shop", domain: "shop.example" }),
  });
  SITE = ((await created.json()) as any).data.id;
  TENANT = (await getSiteById(db, SITE))!.tenantId;

  await recordEvents(
    db,
    TENANT,
    [
      // Two TRY purchases from an ad click, one with items.
      {
        name: "purchase",
        distinctId: "b1",
        siteId: SITE,
        path: "/checkout",
        referrer: "https://www.google.com/",
        utmSource: "google",
        utmMedium: "cpc",
        utmCampaign: "summer",
        revenue: 15_000,
        currency: "TRY",
        props: {
          items: [
            { name: "Mug", quantity: 2, price: 2_500 },
            { name: "Shirt", quantity: 1, price: 10_000 },
          ],
        },
        ts: T0,
      },
      {
        name: "purchase",
        distinctId: "b2",
        siteId: SITE,
        path: "/checkout",
        referrer: "https://www.google.com/",
        utmSource: "google",
        utmMedium: "cpc",
        utmCampaign: "summer",
        revenue: 5_000,
        currency: "TRY",
        ts: T0 + MIN,
      },
      // One EUR purchase, organic. Same magnitude as a TRY one on purpose —
      // if the code ever sums across currencies, the total looks plausible.
      {
        name: "purchase",
        distinctId: "b3",
        siteId: SITE,
        path: "/checkout",
        referrer: "https://duckduckgo.com/",
        revenue: 9_000,
        currency: "EUR",
        ts: T0 + 2 * MIN,
      },
      // A pageview with no revenue: must not become a transaction.
      { name: "page_view", distinctId: "b4", siteId: SITE, path: "/", ts: T0 + 3 * MIN },
    ],
    NOW,
  );
});

afterAll(() => h.cleanup());

const run = () =>
  analyticsRevenue(db, { tenantId: TENANT, from: T0 - MIN, to: NOW, siteId: SITE });

test("currencies are reported side by side, never added together", async () => {
  const r = await run();
  const byCur = Object.fromEntries(r.byCurrency.map((c) => [c.currency, c]));

  expect(Object.keys(byCur).sort()).toEqual(["EUR", "TRY"]);
  expect(byCur.TRY!.revenue).toBe(20_000);
  expect(byCur.TRY!.transactions).toBe(2);
  expect(byCur.TRY!.aov).toBe(10_000);
  expect(byCur.EUR!.revenue).toBe(9_000);
  expect(byCur.EUR!.transactions).toBe(1);

  // The shape itself forbids a single mixed total: there is no scalar to read.
  expect((r as unknown as { revenue?: number }).revenue).toBeUndefined();
});

test("events without an amount are not transactions", async () => {
  const r = await run();
  const total = r.byCurrency.reduce((n, c) => n + c.transactions, 0);
  expect(total).toBe(3); // the pageview is not one
});

test("revenue is attributed to the channel and campaign that brought it", async () => {
  const r = await run();
  const paid = r.byChannel.find((c) => c.channel === "Paid Search");
  expect(paid).toEqual({
    channel: "Paid Search",
    currency: "TRY",
    revenue: 20_000,
    transactions: 2,
  });
  // The EUR purchase came from an organic search, and stays its own row.
  expect(r.byChannel.find((c) => c.channel === "Organic Search")).toEqual({
    channel: "Organic Search",
    currency: "EUR",
    revenue: 9_000,
    transactions: 1,
  });
  expect(r.byCampaign.find((c) => c.campaign === "summer")?.revenue).toBe(20_000);
  // Untagged revenue is "(none)", not folded into a tagged campaign.
  expect(r.byCampaign.find((c) => c.campaign === "(none)")?.currency).toBe("EUR");
});

test("items are tallied from props with quantity applied", async () => {
  const r = await run();
  const shirt = r.topItems.find((i) => i.name === "Shirt");
  const mug = r.topItems.find((i) => i.name === "Mug");
  expect(shirt).toEqual({ name: "Shirt", currency: "TRY", quantity: 1, revenue: 10_000 });
  // 2 × 2,500 — a per-unit price must be multiplied, not counted once.
  expect(mug).toEqual({ name: "Mug", currency: "TRY", quantity: 2, revenue: 5_000 });
});

test("a malformed props blob does not take the report down", async () => {
  // Written straight to the table, bypassing every zod schema — which is
  // exactly how such a row arrives in production: some other tool, a restored
  // backup, a hand-run SQL fix.
  await rawDb.run(
    sql`UPDATE analytics_events SET props = '{not json at all' WHERE distinct_id = 'b2'`,
  );

  // Reading it back must not throw. Before the shape checks in the item loop,
  // this is where a revenue page 500s for the whole workspace.
  const r = await run();
  expect(r.byCurrency.length).toBeGreaterThan(0);
  expect(r.topItems.some((i) => i.name === "Shirt")).toBe(true);
});

test("the raw-event view survives the same bad row", async () => {
  // This one matters more than it looks. The raw-event view is where an
  // operator goes to FIND a malformed row — if it 500s on the same blob, the
  // only diagnosis surface is down exactly when it is needed.
  const res = await h.fetch(`/api/admin/analytics/events?limit=50`);
  expect(res.status).toBe(200);
  const rows = ((await res.json()) as any).data as any[];
  const bad = rows.find((r) => r.distinctId === "b2");
  expect(bad).toBeDefined();
  // Unreadable is reported as absent, which is true, and leaves the rest of
  // the row usable.
  expect(bad.props).toBeNull();
  expect(bad.revenue).toBe(5_000);
  expect(bad.currency).toBe("TRY");
});

test("the REST surface is admin-only", async () => {
  const res = await h.fetch(
    `/api/admin/analytics/revenue?from=${T0 - MIN}&to=${NOW}&siteId=${SITE}`,
  );
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as any;
  expect(data.byCurrency.length).toBe(2);
  expect(data.truncated).toBe(false);

  const anon = makeHarness();
  try {
    expect((await anon.fetch("/api/admin/analytics/revenue")).status).toBe(401);
  } finally {
    anon.cleanup();
  }
});
