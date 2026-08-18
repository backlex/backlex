/**
 * Saved segments — validation, compilation, and the injection surface.
 *
 * A segment is operator-authored JSON that ends up inside a WHERE clause on
 * every report it touches. That makes this the highest-severity input in the
 * analytics feature, so the spec leads with attacks rather than with features:
 * a hostile field name must be refused at validation, and a hostile VALUE must
 * be bound — meaning it filters to nothing rather than executing.
 *
 * The other half is subtler and just as damaging: a segment that silently
 * matches everything looks exactly like a working filter. Several cases below
 * exist only to prove a predicate actually narrows the result.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { parseSegment } from "../src/server/services/analytics-segments";
import {
  analyticsOverview,
  analyticsSessions,
  getSiteById,
  recordEvents,
  resolveSegment,
} from "../src/server/services/analytics";

const MIN = 60_000;
const T0 = Date.parse("2026-08-18T06:00:00.000Z");
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
    body: JSON.stringify({ name: "Seg", domain: "seg.example" }),
  });
  SITE = ((await created.json()) as any).data.id;
  TENANT = (await getSiteById(db, SITE))!.tenantId;

  await recordEvents(
    db,
    TENANT,
    [
      { name: "page_view", distinctId: "m1", siteId: SITE, path: "/pricing", country: "TR", deviceType: "mobile", ts: T0 },
      { name: "page_view", distinctId: "m1", siteId: SITE, path: "/docs", country: "TR", deviceType: "mobile", ts: T0 + MIN },
      { name: "page_view", distinctId: "d1", siteId: SITE, path: "/pricing", country: "DE", deviceType: "desktop", ts: T0 + 2 * MIN },
      { name: "page_view", distinctId: "d2", siteId: SITE, path: "/blog", country: "DE", deviceType: "desktop", ts: T0 + 3 * MIN, props: { plan: "pro" } },
      // A path holding SQL and LIKE metacharacters, so a `contains` on a plain
      // string cannot accidentally match it through wildcard expansion.
      { name: "page_view", distinctId: "x1", siteId: SITE, path: "/a'%_b", country: "FR", deviceType: "desktop", ts: T0 + 4 * MIN },
    ],
    NOW,
  );
});

afterAll(() => h.cleanup());

const overview = (segment: unknown = null) =>
  analyticsOverview(db, {
    tenantId: TENANT,
    from: T0 - MIN,
    to: NOW,
    siteId: SITE,
    segment: segment ? parseSegment(segment) : null,
  } as never);

describe("validation refuses what must never reach SQL", () => {
  test("an unknown field is rejected, and the message does not echo it back", () => {
    let msg = "";
    try {
      parseSegment({ field: "tenant_id", op: "eq", value: "x" });
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain("Allowed:");
    // The rejected string must not be reflected — an error surface is not a
    // place to echo arbitrary caller input.
    expect(msg).not.toContain("tenant_id");
  });

  test("a field name carrying SQL is rejected as a field, not sanitized", () => {
    for (const field of [
      "path; DROP TABLE analytics_events",
      "1=1",
      "path) OR (1=1",
      "props->>'x'",
    ]) {
      expect(() => parseSegment({ field, op: "eq", value: "x" })).toThrow();
    }
  });

  test("an unknown operator is rejected", () => {
    expect(() => parseSegment({ field: "path", op: "regex", value: ".*" })).toThrow();
    expect(() => parseSegment({ revenue: "between", value: 1 })).toThrow();
  });

  test("complexity is capped, so a saved segment cannot become a workload", () => {
    const wide = { all: Array.from({ length: 60 }, () => ({ field: "path", op: "eq", value: "/" })) };
    expect(() => parseSegment(wide)).toThrow();

    let deep: unknown = { field: "path", op: "eq", value: "/" };
    for (let i = 0; i < 8; i++) deep = { all: [deep] };
    expect(() => parseSegment(deep)).toThrow();

    const bigIn = { field: "path", op: "in", value: Array.from({ length: 80 }, (_, i) => `/p${i}`) };
    expect(() => parseSegment(bigIn)).toThrow();
  });

  test("a half-valid tree is refused whole rather than partially applied", () => {
    // Filtering on less than the operator asked for is worse than refusing:
    // the report would look right and be wrong.
    expect(() =>
      parseSegment({ all: [{ field: "path", op: "eq", value: "/" }, { field: "nope", op: "eq", value: "x" }] }),
    ).toThrow();
  });
});

describe("values are bound, never spliced", () => {
  test("a value containing SQL filters to nothing instead of executing", async () => {
    const hostile = "'; DROP TABLE analytics_events; --";
    const r = await overview({ field: "path", op: "eq", value: hostile });
    expect(r.totals.events).toBe(0);

    // The table is still there, which is the point.
    const after = await overview();
    expect(after.totals.events).toBe(5);
  });

  test("LIKE metacharacters in a value match literally", async () => {
    // `%` and `_` are wildcards to LIKE. These predicates do not use LIKE at
    // all (D1 rejects bound patterns), and this is what proves the value is not
    // being treated as a pattern by some other route.
    const wildcardish = await overview({ field: "path", op: "contains", value: "%_" });
    expect(wildcardish.totals.events).toBe(1); // only "/a'%_b"

    const literalQuote = await overview({ field: "path", op: "contains", value: "a'%" });
    expect(literalQuote.totals.events).toBe(1);

    // A bare `%` must not match every row.
    const bare = await overview({ field: "path", op: "startsWith", value: "%" });
    expect(bare.totals.events).toBe(0);
  });
});

describe("a segment actually narrows the report", () => {
  test("equality, membership and negation each filter", async () => {
    expect((await overview({ field: "country", op: "eq", value: "TR" })).totals.events).toBe(2);
    expect(
      (await overview({ field: "country", op: "in", value: ["TR", "DE"] })).totals.events,
    ).toBe(4);
    expect((await overview({ not: { field: "country", op: "eq", value: "TR" } })).totals.events).toBe(3);
  });

  test("all / any compose", async () => {
    const both = await overview({
      all: [
        { field: "deviceType", op: "eq", value: "desktop" },
        { field: "path", op: "eq", value: "/pricing" },
      ],
    });
    expect(both.totals.events).toBe(1); // d1 only

    const either = await overview({
      any: [
        { field: "country", op: "eq", value: "FR" },
        { field: "path", op: "eq", value: "/blog" },
      ],
    });
    expect(either.totals.events).toBe(2);
  });

  test("string position operators work without LIKE", async () => {
    expect((await overview({ field: "path", op: "startsWith", value: "/p" })).totals.events).toBe(2);
    expect((await overview({ field: "path", op: "endsWith", value: "ing" })).totals.events).toBe(2);
    expect((await overview({ field: "path", op: "contains", value: "oc" })).totals.events).toBe(1);
  });

  test("isSet / isNotSet distinguish absent from empty", async () => {
    expect((await overview({ field: "country", op: "isSet" })).totals.events).toBe(5);
    expect((await overview({ field: "utmSource", op: "isNotSet" })).totals.events).toBe(5);
  });

  test("a props key can be filtered on, and a malformed blob does not throw", async () => {
    expect((await overview({ prop: "plan", op: "eq", value: "pro" })).totals.events).toBe(1);

    // `json_extract` RAISES on malformed input — the guard is why this is a
    // filter that returns nothing rather than a 500 for the whole workspace.
    await rawDb.run(
      sql`UPDATE analytics_events SET props = '{broken' WHERE distinct_id = 'm1'`,
    );
    const r = await overview({ prop: "plan", op: "eq", value: "pro" });
    expect(r.totals.events).toBe(1);
  });

  test("the same segment narrows a CTE-based report too", async () => {
    // Sessions builds raw SQL rather than a Drizzle builder, so it takes the
    // other compilation path. Both must agree, or a segment means one thing on
    // the overview and another on sessions.
    const all = await analyticsSessions(db, {
      tenantId: TENANT,
      from: T0 - MIN,
      to: NOW,
      siteId: SITE,
    });
    const de = await analyticsSessions(db, {
      tenantId: TENANT,
      from: T0 - MIN,
      to: NOW,
      siteId: SITE,
      segment: parseSegment({ field: "country", op: "eq", value: "DE" }),
    } as never);
    expect(de.sessions).toBeLessThan(all.sessions);
    expect(de.pageviews).toBe(2);
  });
});

describe("stored definitions are re-validated, and scoped", () => {
  test("a segment saved through the API round-trips and applies", async () => {
    const created = await h.fetch("/api/admin/analytics/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Germany",
        definition: { field: "country", op: "eq", value: "DE" },
      }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as any).data.id;

    const res = await h.fetch(
      `/api/admin/analytics/overview?from=${T0 - MIN}&to=${NOW}&segmentId=${id}`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.totals.events).toBe(2);
  });

  test("a definition that cannot validate is refused at save time", async () => {
    const res = await h.fetch("/api/admin/analytics/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad",
        definition: { field: "tenant_id", op: "eq", value: "x" },
      }),
    });
    expect(res.status).toBe(422);
  });

  test("a stored definition that no longer validates filters nothing", async () => {
    // Written straight to the table, as a looser older validator or a manual
    // fix would leave it. It must not silently filter on garbage.
    const id = crypto.randomUUID();
    await rawDb.run(
      sql`INSERT INTO analytics_segments (id, tenant_id, name, definition, created_at, updated_at)
          VALUES (${id}, ${TENANT}, 'Legacy', ${'{"field":"tenant_id","op":"eq","value":"x"}'}, ${Date.now()}, ${Date.now()})`,
    );
    expect(await resolveSegment(db, TENANT, id)).toBeNull();
  });

  test("resolving is tenant-scoped, so another workspace's id is inert", async () => {
    const created = await h.fetch("/api/admin/analytics/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mine",
        definition: { field: "country", op: "eq", value: "DE" },
      }),
    });
    const id = ((await created.json()) as any).data.id;
    // Same id, a different workspace: no predicate, not someone else's.
    expect(await resolveSegment(db, "some-other-tenant", id)).toBeNull();
  });

  test("the registry is admin-only", async () => {
    const anon = makeHarness();
    try {
      expect((await anon.fetch("/api/admin/analytics/segments")).status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
