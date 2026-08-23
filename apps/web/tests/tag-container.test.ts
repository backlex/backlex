/**
 * Tag manager — the public container endpoint.
 *
 * This is the file every visitor to a customer's site downloads, so the spec
 * cares about three things in this order: it must not become an oracle for
 * enumerating site ids, it must actually start both halves it carries, and it
 * must be cheap on repeat visits.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { getSiteById } from "../src/server/services/analytics";
import {
  createTag,
  createTrigger,
  getPublishedArtifact,
  publishContainer,
} from "../src/server/services/tag-manager";

let h: TestHarness;
let db: any;
let SITE = "";
let EMPTY_SITE = "";
let TENANT: string | null = null;

const makeSite = async (name: string, domain: string): Promise<string> => {
  const r = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, domain }),
  });
  return ((await r.json()) as any).data.id;
};

const container = (id: string, headers: Record<string, string> = {}) =>
  h.fetch(`/api/analytics/tm/${id}.js`, { headers });

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect };

  SITE = await makeSite("Shop", "shop.example");
  TENANT = (await getSiteById(db, SITE))!.tenantId;
  EMPTY_SITE = await makeSite("Quiet", "quiet.example");

  const trigger = await createTrigger(db, TENANT, SITE, { name: "All pages", type: "pageview" });
  await createTag(
    db,
    TENANT,
    SITE,
    {
      name: "Meta",
      kind: "template",
      templateId: "meta_pixel",
      params: { pixelId: "9876543210" },
      triggerIds: [trigger.id],
    },
    "u1",
  );
  await publishContainer(db, TENANT, SITE, { note: "first" }, "u1");
});

afterAll(() => h.cleanup());

describe("what an unknown id learns, and what it does not", () => {
  /**
   * This USED to assert that an unknown id and a registered-but-unconfigured
   * one were byte-identical, so nobody could tell a real site from a guess.
   * That property is deliberately gone, and the trade is written down where it
   * is made (`analytics-collect.ts`, the "registered site is ALWAYS served"
   * comment): a registered site whose script file was empty had no analytics
   * and no error to read, which cost more than the oracle did.
   *
   * What survives is the part that matters. Site ids are v4 UUIDs, so nobody
   * can WALK the space; the oracle only confirms an id you already hold, and
   * anyone holding one read it out of the `<script>` tag on the page.
   */
  test("an unknown id still answers 200 with an empty body, never a 404", async () => {
    const res = await container("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  test("…and a registered site is served even with nothing configured", async () => {
    // The whole point of the change: one website, one script tag, pasted once
    // on a fresh site and never revisited.
    const res = await container(EMPTY_SITE);
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain("window.__backlexTrackerInit = function");
    expect(js).toContain("__backlexTrackerInit({");
    // …but nothing it has no use for. No container means no runtime — measured
    // at ~7.8 KB gzipped of code with nothing to interpret.
    expect(js).not.toContain("window.__backlexTM = function");
    expect(js).not.toContain("__backlexConsentBanner(");
  });

  test("the two are still distinguishable ONLY by body, not by status or headers", async () => {
    // If the oracle has to widen, it widens by exactly one bit and no more: a
    // different status or a different CORS/CORP profile would leak the same
    // fact to a caller that never reads the body.
    const unknown = await container("00000000-0000-0000-0000-000000000000");
    const known = await container(EMPTY_SITE);
    expect(unknown.status).toBe(known.status);
    for (const h of ["content-type", "cache-control", "access-control-allow-origin"]) {
      expect(`${h}: ${unknown.headers.get(h)}`).toBe(`${h}: ${known.headers.get(h)}`);
    }
  });
});

describe("what it serves", () => {
  test("both halves, and both are started", async () => {
    const res = await container(SITE);
    expect(res.status).toBe(200);
    const js = await res.text();

    // The tracker and the runtime travel together in one request, so a site
    // gets measurement and tags from a single script tag.
    expect(js).toContain("window.__backlexTrackerInit = function");
    expect(js).toContain("window.__backlexTM = function");
    // Defining them without calling them is the failure that would pass every
    // other assertion here while doing nothing at all.
    expect(js).toContain("__backlexTrackerInit({");
    expect(js).toContain("__backlexTM({");
  });

  test("the tracker boots with no script element to read", async () => {
    // On this path there is no data-* attribute to read and, for an injected
    // script, no currentScript either. Every attribute read has to go through
    // the guard or the tag throws before its first pageview — on the exact
    // path the tag manager depends on.
    const js = await (await container(SITE)).text();
    expect(js).toContain('attr("data-respect-dnt")');
    expect(js).toContain('attr("data-allow-localhost")');
    expect(js).not.toContain('self.getAttribute("data-respect-dnt")');
    expect(js).not.toContain('self.getAttribute("data-allow-localhost")');
    // And the whole served file has to parse, which is the check no typecheck
    // and no linter performs on a string.
    expect(() => new Function(js)).not.toThrow();
  });

  test("the tracker is configured rather than left to sniff the page", async () => {
    // There is no data-site attribute on this snippet, and currentScript is
    // null for an injected script, so configuration has to be compiled in.
    const js = await (await container(SITE)).text();
    expect(js).toContain(`"s":"${SITE}"`);
    expect(js).toContain("/api/analytics/collect");
  });

  test("the container is data, and it parses", async () => {
    const js = await (await container(SITE)).text();
    const marker = ";__backlexTM(";
    const start = js.lastIndexOf(marker) + marker.length;
    const json = js.slice(start, js.lastIndexOf(");"));
    const parsed = JSON.parse(json.replace(/\\u003c/g, "<"));
    expect(parsed.v).toBe(1);
    expect(parsed.site).toBe(SITE);
    expect(parsed.tags[0].template).toBe("meta_pixel");
    expect(parsed.tags[0].params.pixelId).toBe("9876543210");
  });

  test("it is reachable cross-origin without credentials", async () => {
    const res = await container(SITE);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // A wildcard origin and credentials together are rejected outright by the
    // browser, and there is no ambient authority to want here anyway.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("repeat visits are cheap", () => {
  test("an ETag is served and honoured", async () => {
    const first = await container(SITE);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await container(SITE, { "If-None-Match": etag as string });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // The validator must survive the 304 or the next request has nothing to
    // send back.
    expect(second.headers.get("etag")).toBe(etag);
  });

  test("the cache window is stated, and does not claim to revalidate", async () => {
    // `must-revalidate` forbids serving a STALE entry after expiry; it does not
    // make a browser check before one. Claiming it here would describe a
    // behaviour nobody gets.
    const cc = (await container(SITE)).headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=900");
    expect(cc).not.toContain("must-revalidate");
  });

  test("a request on another origin cannot poison what the next visitor receives", async () => {
    // The body embeds an ABSOLUTE collect endpoint derived from the request
    // URL, and the memo in front of it is per-isolate and shared. Keyed on the
    // site alone, one request arriving on an attacker-controlled host would
    // hand the next minute of real visitors a file pointing their beacons —
    // and the page and referrer those carry — at somebody else's server.
    //
    // Driven through an absolute URL rather than a forged Host header on
    // purpose: this harness builds the request URL from the string it is
    // given, so a Host header alone never reaches `c.req.url` and a test
    // written that way would pass without testing anything.
    const poisoned = await h.fetch(`https://evil.example/api/analytics/tm/${SITE}.js`);
    expect(await poisoned.text()).toContain("evil.example/api/analytics/collect");

    const honest = await (await container(SITE)).text();
    expect(honest).not.toContain("evil.example");
    expect(honest).toContain("localhost:5173/api/analytics/collect");
  });

  test("a publish changes the ETag", async () => {
    const before = (await container(SITE)).headers.get("etag");
    const site = await makeSite("Second", "second.example");
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    await createTag(
      db,
      TENANT,
      site,
      { name: "T", kind: "template", templateId: "snap_pixel", params: { pixelId: "s1" }, triggerIds: [tr.id] },
      "u1",
    );
    await publishContainer(db, TENANT, site, {}, "u1");
    const other = (await container(site)).headers.get("etag");
    expect(other).not.toBe(before);
  });

  test("the ETag also covers the runtime, not only the published artifact", async () => {
    // The file served here is tracker + runtime + artifact, but the validator
    // was derived from the artifact hash alone. So a browser holding a cached
    // container revalidated, got a bodyless 304 -- which refreshes the freshness
    // window -- and went on executing the OLD runtime indefinitely. A fix to the
    // consent gate could not be pushed to a live site at all; it waited on an
    // operator republishing for some unrelated reason.
    //
    // Asserted through the SERVED body rather than by reaching into the route,
    // so it fails if the fingerprint ever stops being part of the validator.
    const res = await container(SITE);
    const etag = res.headers.get("etag");
    const body = await res.text();
    expect(etag).toBeTruthy();

    const { weakETag, weakHash } = await import("../src/server/lib/etag");
    const { TRACKER_JS } = await import("../src/server/services/analytics-tracker");
    const { TAG_RUNTIME_JS } = await import("../src/server/services/tag-runtime");
    const { CONSENT_BANNER_JS } = await import("../src/server/services/consent-banner-bundle");
    const published = await getPublishedArtifact(db, SITE);

    // Both halves really are in the body, so both belong in its validator.
    expect(body).toContain(TRACKER_JS);
    expect(body).toContain(TAG_RUNTIME_JS);

    // COMPOSITIONAL, not one constant over all three. `SITE` has a published
    // container and no consent policy, so its body is tracker + runtime and its
    // fingerprint must be exactly that. A whole-constant fingerprint would leave
    // a consent-only site's validator unmoved while its body changed — and a
    // 304 refreshes freshness, so that browser would keep the old composition
    // indefinitely.
    expect(etag).toBe(weakETag([published!.hash, weakHash(TRACKER_JS + TAG_RUNTIME_JS)]));
    // The banner is genuinely absent from this body, which is what makes the
    // assertion above about composition rather than about a renamed constant.
    expect(body).not.toContain(CONSENT_BANNER_JS);
    // ...and the artifact hash alone is NOT the validator any more, which is the
    // whole point: this is the assertion that fails if someone reverts to it.
    expect(etag).not.toBe(weakETag([published!.hash]));
  });
});

/**
 * The container body is the SAME for every visitor, whatever the edge says
 * about where they are.
 *
 * The regional-presets phase measured this and stopped there: the file is
 * `public, max-age=900` behind a memo keyed on `(siteId, origin)` with no
 * country in it and no `Vary` — and no `Vary` could help, because every geo
 * source this repo has is a header the EDGE injects, never one the browser
 * sent, so no cache can key on it. Whoever missed the cache first would fix the
 * posture for everyone behind it. This is the tripwire against the next person
 * "finishing" the phase by wiring `enrichmentFromRequest` into the handler,
 * which is one import away — `analytics-collect.ts` already imports it for the
 * write path.
 */
describe("the per-site file is geo-blind", () => {
  test("two countries get byte-identical bodies and the same ETag", async () => {
    // The MEMO has to be cleared between the two requests, and that is the
    // whole methodology rather than hygiene. `getContainerEntry` is keyed on
    // (siteId, origin), so a second request hits the first one's cached body
    // and agrees with it no matter what the handler does — measured: without
    // this the test stayed GREEN with `cf-ipcountry` deliberately spliced into
    // the body, which is precisely the bug it exists to catch. Clearing it
    // makes both requests take the compile path, where the difference would be.
    const { invalidateContainer } = await import(
      "../src/server/services/tag-container-cache"
    );
    const withCountry = async (country: string) => {
      invalidateContainer(SITE);
      const res = await h.app.fetch(
        new Request(`${h.env.APP_URL}/api/analytics/tm/${SITE}.js`, {
          headers: {
            "cf-ipcountry": country,
            "x-vercel-ip-country": country,
            "x-backlex-country": country,
          },
        }),
      );
      return { etag: res.headers.get("etag"), vary: res.headers.get("vary"), body: await res.text() };
    };

    const de = await withCountry("DE");
    const us = await withCountry("US");

    // The premise: this is a real body, not two empty 200s agreeing vacuously.
    expect(de.body.length).toBeGreaterThan(1000);
    expect(de.body).toBe(us.body);
    expect(de.etag).toBe(us.etag);
    // …and nothing on the response invites a cache to split on a header it
    // will never see.
    expect(de.vary).toBeNull();
  });
});

/**
 * The canonical path, and the one that can never be removed.
 *
 * `/api/analytics/tm/<id>.js` named two products (analytics, tag manager) while
 * serving three — the same category error the admin nav carried, and the repo
 * had already argued against it in `routes/consent-public.ts` for the consent
 * config route. `/api/site/<id>.js` is the canonical home.
 *
 * The old path is PERMANENT, not deprecated: it is inside a `<script>` tag on
 * every already-deployed customer page and there is no version negotiation. A
 * removed path stops collection everywhere, silently.
 */
describe("the per-site script has two paths and one handler", () => {
  const at = (path: string) =>
    h.app.fetch(
      new Request(`${h.env.APP_URL}${path}`, {
        headers: { Origin: "https://customer.example" },
      }),
    );

  test("both paths return the same body and the same ETag", async () => {
    const { invalidateContainer } = await import(
      "../src/server/services/tag-container-cache"
    );
    // Cleared between the two, or the second is served the first's memo entry
    // and agrees with itself no matter what the handler does.
    invalidateContainer(SITE);
    const oldPath = await at(`/api/analytics/tm/${SITE}.js`);
    const oldBody = await oldPath.text();
    invalidateContainer(SITE);
    const newPath = await at(`/api/site/${SITE}.js`);
    const newBody = await newPath.text();

    expect(oldBody.length).toBeGreaterThan(1000);
    expect(newBody).toBe(oldBody);
    expect(newPath.headers.get("etag")).toBe(oldPath.headers.get("etag"));
  });

  test("the new path inherits the whole public-subresource profile", async () => {
    // Measured, not assumed: a route mounted under a fresh prefix inherits the
    // app DEFAULTS, and every one of them is wrong for a file a browser loads
    // from somebody else's domain. Before the exemption lists were updated this
    // path answered CORP `same-origin` (every browser discards the script), a
    // single-origin ACAO, `Access-Control-Allow-Credentials: true` on an
    // anonymous document, `Vary: Origin` on a `public, max-age=900` asset, and
    // a `Set-Cookie`.
    const res = await at(`/api/site/${SITE}.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("set-cookie") ?? "").not.toContain("backlex-tenant");
  });

  test("mounting the canonical prefix publishes exactly ONE route", async () => {
    // The alternative shape — mounting the whole collect sub-app twice — would
    // also expose `/api/site/collect`, a WRITE endpoint, at an unadvertised URL
    // that is on no exemption list.
    for (const path of ["/api/site/collect", "/api/site/script.js"]) {
      const res = await h.app.fetch(
        new Request(`${h.env.APP_URL}${path}`, { method: "POST" }),
      );
      expect(`${path} is not a route: ${res.status !== 200 && res.status !== 202}`).toBe(
        `${path} is not a route: true`,
      );
    }
  });

  test("the snippet every surface hands out names the canonical path", async () => {
    const { installSnippet } = await import("../src/server/services/install-snippet");
    const snippet = installSnippet("https://admin.example", SITE);
    expect(snippet).toContain(`/api/site/${SITE}.js`);
    expect(snippet).not.toContain("/api/analytics/");
    // And it is the ONE emitter — nothing else may rebuild the literal.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dir, "..", "src", "server");
    for (const f of ["routes/tag-manager.ts", "routes/analytics.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(`${f} rebuilds the snippet: ${/script defer src=/.test(src)}`).toBe(
        `${f} rebuilds the snippet: false`,
      );
    }
  });

  test("the snippet cannot carry markup out of the host or the id", async () => {
    const { installSnippet } = await import("../src/server/services/install-snippet");

    // The premise, asserted rather than assumed: `new URL` does NOT sanitise a
    // quote out of the authority. It throws on a space and on `<`, so the only
    // character that can actually arrive is `"` — and the percent-encoded form
    // DECODES to it, which is the shape that survives a naive Host check.
    expect(new URL('http://a"x.com/api/x').origin).toBe('http://a"x.com');
    expect(new URL("http://a%22x.com/api/x").origin).toBe('http://a"x.com');

    // So the emitter has to close the attribute itself. This string is HTML by
    // contract — an operator pastes it into their own page — and neither
    // interpolated value is a uuid by construction: the tag manager's install
    // route validates `siteId` as `z.string().min(1)`.
    const poisoned = installSnippet('https://a"><script>alert(1)</script>.com', SITE);
    expect(poisoned).not.toContain("<script>alert(1)</script>");
    expect(poisoned).toContain("&quot;&gt;&lt;script&gt;");
    // Exactly one tag, still, and it is ours. Note the assertion is a COUNT and
    // not `not.toContain('"><')` — the snippet's own `.js"></script>` contains
    // that sequence legitimately, so the obvious spelling fails on a correct
    // emitter and would have been "fixed" by weakening the escape.
    expect(poisoned.match(/<script/g)).toHaveLength(1);
    expect(poisoned.match(/<\/script>/g)).toHaveLength(1);

    const badId = installSnippet("https://admin.example", 'abc"></script><img src=x onerror=y>');
    expect(badId).not.toContain("<img");
    expect(badId).toContain("&quot;&gt;&lt;/script&gt;");
    expect(badId.match(/<script/g)).toHaveLength(1);
    expect(badId.match(/<\/script>/g)).toHaveLength(1);

    // And the escaping is not so eager that a normal snippet changes: an
    // origin and a uuid contain none of the four characters, so this is the
    // identity function on every real input.
    expect(installSnippet("https://admin.example", SITE)).toBe(
      `<script defer src="https://admin.example/api/site/${SITE}.js"></script>`,
    );
  });
});
