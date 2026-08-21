/**
 * The public consent-config endpoint, driven the way a banner drives it: no
 * session, a foreign origin, and nothing but a public site id.
 *
 * Three properties here are load-bearing and none of them is visible from the
 * service tests:
 *
 *  1. **The CORS exemption.** Without an entry in `app.ts`'s `CORS_EXEMPT`, the
 *     credentialed `cors()` replaces `ACAO: *` with the one allowed origin, and
 *     every banner on every customer domain fails. Nothing in the repo pinned
 *     that array before this file, and no existing test fetches an exempt path
 *     WITH a query string — which is exactly the shape this route uses.
 *  2. **Enumeration parity.** Site ids are public, so a status that differs by
 *     whether an id exists is an oracle. Unknown, disabled and orphaned must be
 *     byte-identical.
 *  3. **Metering.** An anonymous request resolves to the DEFAULT workspace, so
 *     without `setMeterTenant` the owner's public traffic sits outside their own
 *     quota and someone else pays for it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { getSiteById } from "../src/server/services/analytics";
import { savePolicy } from "../src/server/services/consent";

let h: TestHarness;
let db: never;
let SITE = "";
let TENANT: string | null = null;

const OFF_BODY = '{"v":1,"enabled":false}';

/**
 * No cookie jar. `h.fetch` replays the admin session, and this route's whole
 * point is that it works for a caller who has none — a test that kept the
 * cookie would pass against a route that quietly required a session.
 */
const anonFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers ?? {});
  // A foreign origin, deliberately: a customer's domain is never on the
  // credentialed allowlist, which is the situation being tested.
  if (!headers.has("Origin")) headers.set("Origin", "https://customer.example");
  if (!headers.has("X-Forwarded-For")) headers.set("X-Forwarded-For", "203.0.113.9");
  return h.app.fetch(new Request(`${h.env.APP_URL}${path}`, { ...init, headers }));
};

const newSite = async (name: string): Promise<string> => {
  const res = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, domain: `${name}.example` }),
  });
  return ((await res.json()) as any).data.id;
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect } as never;

  SITE = await newSite("cfg");
  TENANT = (await getSiteById(db, SITE))!.tenantId;
  await savePolicy(db, TENANT, SITE, {
    undecidedBehaviour: "block",
    trackerCategory: "none",
    categoriesOffered: ["analytics", "marketing"],
    wording: { en: { title: "Cookies" }, "pt-BR": { title: "Cookies" } },
    enabled: true,
  });
});

afterAll(() => h.cleanup());

describe("it answers a foreign origin without credentials", () => {
  test("ACAO is a star, not the app's own origin", async () => {
    const res = await anonFetch(`/api/consent/config?s=${SITE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // The failure this actually catches: a missing CORS_EXEMPT entry answers
    // with the app's own origin, which is a plausible-looking header that
    // breaks every real caller. Asserting both makes the diagnosis obvious.
    expect(res.headers.get("access-control-allow-origin")).not.toBe(h.env.APP_URL);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    // `Vary: Origin` would make the response uncacheable per-origin, defeating
    // the point of a document identical for the whole internet.
    expect(res.headers.get("vary") ?? "").not.toContain("Origin");
  });

  test("…and the query string does not defeat the exemption", async () => {
    // `CORS_EXEMPT` is an exact-path `includes`, and this route is the first
    // exempt path that carries a query string. If the match were ever made
    // against the URL rather than `c.req.path`, every real request would miss
    // the carve-out while a bare `/api/consent/config` kept passing.
    const res = await anonFetch(`/api/consent/config?s=${SITE}&extra=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("the body is the artifact and carries no workspace id", async () => {
    const res = await anonFetch(`/api/consent/config?s=${SITE}`);
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("application/json");
    const cfg = JSON.parse(text);
    expect(cfg.v).toBe(1);
    expect(cfg.site).toBe(SITE);
    expect(cfg.categories).toEqual(["analytics", "marketing"]);
    expect(cfg.undecided).toBe("block");
    // Guard against a vacuous pass: prove the needle is a real, non-empty
    // string before asserting the haystack lacks it.
    expect(typeof TENANT === "string" && TENANT.length > 0).toBe(true);
    expect(text).not.toContain(TENANT!);
  });
});

describe("caching", () => {
  test("an ETag round-trips to a 304 with the headers intact", async () => {
    const first = await anonFetch(`/api/consent/config?s=${SITE}`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toContain("max-age=300");

    const second = await anonFetch(`/api/consent/config?s=${SITE}`, {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // A 304 that dropped the CORS header would fail in the browser as hard as
    // a 200 that did.
    expect(second.headers.get("access-control-allow-origin")).toBe("*");
    expect(second.headers.get("etag")).toBe(etag);
  });

  test("the ETag tracks content, not writes", async () => {
    const before = (await anonFetch(`/api/consent/config?s=${SITE}`)).headers.get("etag");

    // An empty save moves `updated_at` and nothing else. If the validator were
    // derived from the row's timestamp rather than the artifact's hash, this
    // would needlessly bust every visitor's cache.
    await savePolicy(db, TENANT, SITE, {});
    expect((await anonFetch(`/api/consent/config?s=${SITE}`)).headers.get("etag")).toBe(before);

    await savePolicy(db, TENANT, SITE, { wording: { en: { title: "New copy" } } });
    const after = await anonFetch(`/api/consent/config?s=${SITE}`);
    expect(after.headers.get("etag")).not.toBe(before);
    // And the new content is served immediately — the memo is invalidated on
    // save, so an operator checking their own site does not read the old copy
    // for a minute and conclude the save failed.
    expect(await after.text()).toContain("New copy");
  });
});

describe("an id tells a caller nothing", () => {
  test("unknown, disabled and orphaned answer identically", async () => {
    const disabled = await newSite("cfg-off");
    const dTenant = (await getSiteById(db, disabled))!.tenantId;
    await savePolicy(db, dTenant, disabled, {
      undecidedBehaviour: "allow",
      trackerCategory: "analytics",
      enabled: false,
    });

    const cases = [
      `/api/consent/config?s=${disabled}`,
      "/api/consent/config?s=00000000-0000-4000-8000-000000000000",
      "/api/consent/config",
      "/api/consent/config?s=",
    ];
    for (const path of cases) {
      const res = await anonFetch(path);
      expect(`${path} → ${res.status}`).toBe(`${path} → 200`);
      expect(`${path} → ${await res.text()}`).toBe(`${path} → ${OFF_BODY}`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      // No validator on the off document, so switching a banner back on is not
      // pinned behind a 304 the browser would keep revalidating into.
      expect(res.headers.get("etag")).toBeNull();
    }
  });
});

describe("metering", () => {
  /**
   * Both cases below need a site in a SECOND workspace, and that is the whole
   * methodology rather than a detail.
   *
   * An anonymous request resolves to the DEFAULT workspace in
   * `tenantMiddleware`, and the harness admin's own tenant IS the default
   * workspace — so a test that measured `SITE` would be comparing correct
   * attribution against the fallback's answer, which are the same number.
   * Measured: deleting `setMeterTenant` from the route left the cache-hit case
   * still passing until it was moved onto its own workspace.
   */
  const meterFixture = async () => {
    const { resetUsageState, flushUsage } = await import("../src/server/services/usage");
    const ctx = await buildContext(h.env);
    const anyDb = ctx.db as any;
    const sqliteSchema = (await import("@backlex/db/sqlite")).schema;
    const { eq } = await import("drizzle-orm");

    const defaultTenant = ((await anyDb.select().from(sqliteSchema.tenants)) as {
      id: string;
    }[])[0]!.id;

    const ownerTenant = crypto.randomUUID();
    await anyDb.insert(sqliteSchema.tenants).values({
      id: ownerTenant,
      slug: `cfg-owner-${ownerTenant.slice(0, 8)}`,
      name: "Config owner workspace",
    });
    const siteId = crypto.randomUUID();
    await anyDb.insert(sqliteSchema.analyticsSites).values({
      id: siteId,
      tenantId: ownerTenant,
      name: "Owned",
      domain: `owned-${siteId.slice(0, 8)}.example`,
    });
    await savePolicy(db, ownerTenant, siteId, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      enabled: true,
    });

    // The premise the assertions rest on, asserted rather than assumed.
    expect(ownerTenant).not.toBe(defaultTenant);

    // Measure a DELTA per workspace — earlier requests in this file already
    // billed the default workspace, so "a counter exists" would hold even with
    // the mis-attribution present.
    const billed = async (tid: string): Promise<number> => {
      await flushUsage(ctx);
      const rows = (await anyDb
        .select()
        .from(sqliteSchema.usageCounters)
        .where(eq(sqliteSchema.usageCounters.tenantId, tid))) as { requests: number }[];
      return rows.reduce((n, r) => n + Number(r.requests ?? 0), 0);
    };
    resetUsageState();
    return { siteId, ownerTenant, defaultTenant, billed };
  };

  test("an anonymous read bills the site's owner, not the default workspace", async () => {
    const { siteId, ownerTenant, defaultTenant, billed } = await meterFixture();
    const ownerBefore = await billed(ownerTenant);
    const defaultBefore = await billed(defaultTenant);

    const res = await anonFetch(`/api/consent/config?s=${siteId}`);
    expect(res.status).toBe(200);

    expect(await billed(ownerTenant)).toBeGreaterThan(ownerBefore);
    expect(await billed(defaultTenant)).toBe(defaultBefore);
  });

  test("a cache hit meters too", async () => {
    // The subtle half: the memo short-circuits the DB read, so a `setMeterTenant`
    // reachable only on the miss path would attribute the first request of each
    // minute correctly and every one after it to the default workspace.
    const { siteId, ownerTenant, defaultTenant, billed } = await meterFixture();

    // Warm the memo, then measure ONLY the hits that follow.
    await anonFetch(`/api/consent/config?s=${siteId}`);
    const ownerBefore = await billed(ownerTenant);
    const defaultBefore = await billed(defaultTenant);

    await anonFetch(`/api/consent/config?s=${siteId}`);
    await anonFetch(`/api/consent/config?s=${siteId}`);

    expect(await billed(ownerTenant)).toBeGreaterThan(ownerBefore);
    expect(await billed(defaultTenant)).toBe(defaultBefore);
  });
});
