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

describe("it is not an enumeration oracle", () => {
  test("an unknown site id answers exactly like an unpublished one", async () => {
    // The collect route answers 202 for an unknown id for this reason, and the
    // reasoning carries: a status that differs by whether an id exists lets
    // anyone walk the space and learn which workspaces have sites.
    const unknown = await container("00000000-0000-0000-0000-000000000000");
    const unpublished = await container(EMPTY_SITE);
    expect(unknown.status).toBe(unpublished.status);
    expect(await unknown.text()).toBe(await unpublished.text());
    expect(unknown.status).toBe(200);
  });

  test("a site with no published version serves an empty file, not a 404", async () => {
    const res = await container(EMPTY_SITE);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toContain("javascript");
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
    const published = await getPublishedArtifact(db, SITE);

    // Both halves really are in the body, so both belong in its validator.
    expect(body).toContain(TRACKER_JS);
    expect(body).toContain(TAG_RUNTIME_JS);

    expect(etag).toBe(
      weakETag([published!.hash, weakHash(TRACKER_JS + TAG_RUNTIME_JS)]),
    );
    // ...and the artifact hash alone is NOT the validator any more, which is the
    // whole point: this is the assertion that fails if someone reverts to it.
    expect(etag).not.toBe(weakETag([published!.hash]));
  });
});
