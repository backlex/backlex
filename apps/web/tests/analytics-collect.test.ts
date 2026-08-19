/**
 * The public web tag: its collect endpoint, the cookieless identity, and the
 * site registry.
 *
 * The things worth pinning here are the ones that look fine on a screenshot of
 * a working dashboard:
 *
 *  - the request must succeed with NO auth header and NO JSON content-type,
 *    because `sendBeacon` can send neither — and it must answer `ACAO: *`
 *    WITHOUT credentials, because a wildcard origin plus credentials is
 *    rejected by the browser outright;
 *  - the same visitor must resolve to the same id across requests within a
 *    day, from any isolate, which is why the salt is derived rather than
 *    generated;
 *  - the IP and user-agent go into that hash and must appear in no column;
 *  - the server-side filters (bots, excluded paths, ignored IPs, known origin)
 *    must actually drop rows, since the client-side half is only advice.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { TRACKER_JS } from "../src/server/services/analytics-tracker";

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0";
const UA_BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

let h: TestHarness;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
});
afterAll(() => h.cleanup());

const createSite = async (over: Record<string, unknown> = {}) => {
  const res = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Marketing", domain: "example.com", ...over }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).data;
};

/** Exactly what the tag sends: text/plain, no auth header, no custom header. */
const beacon = (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  h.fetch("/api/analytics/collect", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": UA_DESKTOP,
      Origin: "https://example.com",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const rows = async (limit = 50) => {
  const res = await h.fetch(`/api/admin/analytics/events?limit=${limit}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).data as any[];
};

describe("the tag script", () => {
  test("is served as JavaScript, readable from any origin", async () => {
    const res = await h.fetch("/api/analytics/script.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const js = await res.text();
    expect(js).toContain("sendBeacon");
    expect(js).toContain("data-site");
    // The served file must START the tracker, not merely define it. The tag is
    // a function now so the tag-manager file can boot it with configuration,
    // and a route that shipped the definition alone would pass every other
    // assertion here while measuring nothing at all.
    expect(js).toContain("__backlexTrackerInit(null);");
    expect(js.indexOf("__backlexTrackerInit(null);")).toBeGreaterThan(
      js.indexOf("window.__backlexTrackerInit = function"),
    );
  });

  test("it boots once, however many snippets a page carries", () => {
    // A site migrating from the legacy snippet to the tag-manager file will
    // briefly have both installed. Without the guard that page reports every
    // visit twice, silently, and the numbers just look like growth.
    expect(TRACKER_JS).toContain("__backlexTagBooted");
  });

  test("the collect endpoint is derived from the last slash, not a filename", () => {
    // The old form searched its own src for "/script.js" and fell back to a
    // RELATIVE path when it was absent — which resolves against the CUSTOMER's
    // page, so every beacon would have gone to their own server and 404ed
    // invisibly. Any second URL shape for the tag reintroduces that the moment
    // the filename search misses.
    expect(TRACKER_JS).toContain("lastIndexOf");
    expect(TRACKER_JS).not.toContain('indexOf("/script.js")');
  });

  test("its source survives being a template literal", () => {
    // The tag lives inside a TS template literal. A backslash there is eaten
    // BEFORE the browser ever sees it — a regex written naturally would ship
    // subtly wrong, e.g. `[::1]` decaying from a literal into a character
    // class. Backticks and `${` would break the literal outright. The tag is
    // written to contain none of the three; this is what keeps it that way.
    expect(TRACKER_JS).not.toInclude("\\");
    expect(TRACKER_JS).not.toInclude("`");
    expect(TRACKER_JS).not.toInclude("${");
  });
});

describe("collect", () => {
  test("accepts a beacon with no auth header and no JSON content-type", async () => {
    const site = await createSite();
    const res = await beacon({ s: site.id, n: "page_view", p: "/pricing", h: "example.com" });
    expect(res.status).toBe(204);

    const hit = (await rows()).find((r) => r.path === "/pricing");
    expect(hit).toBeDefined();
    expect(hit.idScope).toBe("daily");
    expect(hit.siteId).toBe(site.id);
    expect(hit.source).toBe("web");
  });

  test("answers a wildcard origin WITHOUT credentials", async () => {
    const site = await createSite({ domain: "cors.example" });
    const res = await beacon(
      { s: site.id, n: "page_view", p: "/", h: "cors.example" },
      { Origin: "https://cors.example" },
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // `ACAO: *` together with credentials is rejected by the browser, so this
    // header must be absent — not "false", absent.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("preflight is answered in-route, since the app's CORS layer skips this path", async () => {
    const res = await h.fetch("/api/analytics/collect", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("a malformed or oversized body is swallowed, not 500'd", async () => {
    const bad = await h.fetch("/api/analytics/collect", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json at all",
    });
    expect(bad.status).toBe(204);

    // Refused on the DECLARED length, before the body is buffered — checking
    // afterwards still lets an unauthenticated caller make us hold the string.
    const huge = await h.fetch("/api/analytics/collect", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Content-Length": "999999" },
      body: "x".repeat(20_000),
    });
    expect(huge.status).toBe(204);

    // …and with no declared length, the read itself is still bounded.
    const undeclared = await h.fetch("/api/analytics/collect", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(20_000),
    });
    expect(undeclared.status).toBe(204);
  });

  test("an unknown site id is accepted silently rather than confirming it exists", async () => {
    const before = (await rows(100)).length;
    const res = await beacon({ s: "00000000-0000-0000-0000-000000000000", n: "page_view", p: "/x" });
    // 202, not 404: status codes must not let a caller enumerate site ids.
    expect(res.status).toBe(202);
    expect((await rows(100)).length).toBe(before);
  });
});

describe("cookieless identity", () => {
  test("the same visitor resolves to the same id twice, and it is not the raw IP", async () => {
    const site = await createSite({ domain: "ident.example" });
    await beacon({ s: site.id, n: "id_probe", p: "/a", h: "ident.example" }, { Origin: "https://ident.example" });
    await beacon({ s: site.id, n: "id_probe", p: "/b", h: "ident.example" }, { Origin: "https://ident.example" });

    const hits = (await rows(100)).filter((r) => r.name === "id_probe");
    expect(hits.length).toBe(2);
    expect(hits[0].distinctId).toBe(hits[1].distinctId);
    expect(hits[0].distinctId.length).toBe(32);

    // The IP and user-agent are hash INPUTS. Nothing may carry them onward:
    // that is the entire privacy claim, and a serialized row is where a leak
    // would actually show up.
    const serialized = JSON.stringify(hits[0]);
    expect(serialized).not.toContain(h.clientIp);
    expect(serialized).not.toContain("Firefox/125.0");
    expect(serialized).not.toContain("Mozilla");
  });

  test("a different user-agent is a different visitor", async () => {
    const site = await createSite({ domain: "ua.example", filterBots: false });
    await beacon({ s: site.id, n: "ua_probe", p: "/a", h: "ua.example" }, { Origin: "https://ua.example" });
    await beacon(
      { s: site.id, n: "ua_probe", p: "/a", h: "ua.example" },
      {
        Origin: "https://ua.example",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    );
    const hits = (await rows(100)).filter((r) => r.name === "ua_probe");
    expect(hits.length).toBe(2);
    expect(hits[0].distinctId).not.toBe(hits[1].distinctId);
  });

  test("cookieless rows are excluded from cohort reports, and the overview says so", async () => {
    const now = Date.now();
    const res = await h.fetch(
      `/api/admin/analytics/overview?from=${now - 86_400_000}&to=${now}`,
    );
    const { data } = (await res.json()) as any;

    // Tag traffic exists by now, so the share must be non-zero and the honest
    // per-day figure must be populated.
    expect(data.totals.cookielessShare).toBeGreaterThan(0);
    expect(data.totals.visitorsPerDay).not.toBeNull();

    // Retention keys cohorts on a visitor's first-ever day. A rotating id makes
    // every visitor new every day, so including it would not leave the report
    // incomplete — it would make it wrong. `durableOnly()` is what stops that.
    const ret = await h.fetch("/api/admin/analytics/retention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: now - 86_400_000, to: now }),
    });
    const cohorts = ((await ret.json()) as any).data.cohorts as any[];
    const daily = (await rows(200)).filter((r) => r.idScope === "daily");
    expect(daily.length).toBeGreaterThan(0);
    const cohortTotal = cohorts.reduce((n, c) => n + c.size, 0);
    const durableVisitors = new Set(
      (await rows(200)).filter((r) => r.idScope !== "daily").map((r) => r.distinctId),
    );
    expect(cohortTotal).toBeLessThanOrEqual(durableVisitors.size);
  });
});

describe("consent", () => {
  test("a denied event is dropped by the SERVER, not only by the tag", async () => {
    // The tag's own check is advice: a modified script, or one loaded from a
    // cache, can decline to follow it. This is the half an operator can point
    // at in an audit.
    const site = await createSite({ domain: "consent.example" });
    const res = await beacon(
      { s: site.id, n: "consent_probe", p: "/", h: "consent.example", c: "denied" },
      { Origin: "https://consent.example" },
    );
    expect(res.status).toBe(204);
    expect((await rows(200)).some((r) => r.name === "consent_probe")).toBe(false);

    // …and an explicit grant still lands.
    const ok = await beacon(
      { s: site.id, n: "consent_ok", p: "/", h: "consent.example", c: "granted" },
      { Origin: "https://consent.example" },
    );
    expect(ok.status).toBe(204);
    expect((await rows(200)).some((r) => r.name === "consent_ok")).toBe(true);
  });

  test("the tag ships the mechanical half of consent mode and says so", () => {
    // Reading gtag's dataLayer, GPC and DNT, plus an explicit override. What
    // it deliberately does NOT do is GA4's behavioural modeling — inferring
    // the conversions it was not allowed to observe.
    expect(TRACKER_JS).toContain("analytics_storage");
    expect(TRACKER_JS).toContain("globalPrivacyControl");
    expect(TRACKER_JS).toContain("doNotTrack");
    expect(TRACKER_JS).toContain("backlex.consent");
  });
});

describe("server-side filters", () => {
  test("a declared crawler is dropped when the site asks for it", async () => {
    const site = await createSite({ domain: "bots.example", filterBots: true });
    const res = await beacon(
      { s: site.id, n: "bot_probe", p: "/", h: "bots.example" },
      { Origin: "https://bots.example", "User-Agent": UA_BOT },
    );
    expect(res.status).toBe(202);
    expect((await rows(200)).some((r) => r.name === "bot_probe")).toBe(false);
  });

  test("an excluded path never lands, including its glob form", async () => {
    const site = await createSite({
      domain: "ex.example",
      excludedPaths: ["/admin/*", "/health"],
    });
    for (const p of ["/admin/users", "/health"]) {
      const res = await beacon(
        { s: site.id, n: "ex_probe", p, h: "ex.example" },
        { Origin: "https://ex.example" },
      );
      expect(res.status).toBe(202);
    }
    expect((await rows(200)).some((r) => r.name === "ex_probe")).toBe(false);

    // …and a path that merely looks similar still lands.
    const ok = await beacon(
      { s: site.id, n: "ex_ok", p: "/administration", h: "ex.example" },
      { Origin: "https://ex.example" },
    );
    expect(ok.status).toBe(204);
    expect((await rows(200)).some((r) => r.name === "ex_ok")).toBe(true);
  });

  test("an ignored IP never lands", async () => {
    const site = await createSite({
      domain: "ip.example",
      ignoredIps: [h.clientIp],
    });
    const res = await beacon(
      { s: site.id, n: "ip_probe", p: "/", h: "ip.example" },
      { Origin: "https://ip.example" },
    );
    expect(res.status).toBe(202);
    expect((await rows(200)).some((r) => r.name === "ip_probe")).toBe(false);
  });

  test("a foreign origin is refused when the site requires a known one", async () => {
    const site = await createSite({ domain: "strict.example", requireKnownOrigin: true });
    const bad = await beacon(
      { s: site.id, n: "origin_probe", p: "/", h: "attacker.test" },
      { Origin: "https://attacker.test" },
    );
    expect(bad.status).toBe(202);
    expect((await rows(200)).some((r) => r.name === "origin_probe")).toBe(false);

    // A subdomain of the registered domain is the same site.
    const good = await beacon(
      { s: site.id, n: "origin_ok", p: "/", h: "blog.strict.example" },
      { Origin: "https://blog.strict.example" },
    );
    expect(good.status).toBe(204);
    expect((await rows(200)).some((r) => r.name === "origin_ok")).toBe(true);
  });
});

describe("sites registry", () => {
  test("a domain is normalized however it was pasted", async () => {
    for (const input of ["https://Norm.Example/path", "norm.example:8443", "norm.example"]) {
      const site = await createSite({ domain: input, name: "n" });
      expect(site.domain).toBe("norm.example");
      await h.fetch(`/api/admin/analytics/sites/${site.id}`, { method: "DELETE" });
    }
  });

  test("list, update and delete round-trip", async () => {
    const site = await createSite({ domain: "crud.example", name: "Crud" });
    const patched = await h.fetch(`/api/admin/analytics/sites/${site.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", filterBots: false }),
    });
    expect(patched.status).toBe(200);
    const data = ((await patched.json()) as any).data;
    expect(data.name).toBe("Renamed");
    expect(data.filterBots).toBe(false);

    const listed = await h.fetch("/api/admin/analytics/sites");
    expect(((await listed.json()) as any).data.some((s: any) => s.id === site.id)).toBe(true);

    expect(
      (await h.fetch(`/api/admin/analytics/sites/${site.id}`, { method: "DELETE" })).status,
    ).toBe(200);
    const after = await h.fetch("/api/admin/analytics/sites");
    expect(((await after.json()) as any).data.some((s: any) => s.id === site.id)).toBe(false);
  });

  test("the registry is admin-only", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch("/api/admin/analytics/sites");
      expect(res.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
