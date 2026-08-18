/**
 * Server-side enrichment of analytics events — the website dimensions.
 *
 * Two layers, tested separately because they fail differently:
 *
 * 1. The pure parsers (`parseUserAgent`, `parseUtm`, `countryFromRequest`).
 *    These are regex tables whose ORDER is the whole subtlety — every Chromium
 *    browser carries `Safari` in its UA, an Android tablet says `Android`, and
 *    recent iPadOS says `Mac OS X`. A reordering is a silent reclassification
 *    of real traffic, so the cases below are chosen to fail on one.
 * 2. The ingest wiring — that the parsed values actually land on the row, that
 *    the client cannot override them, and that the raw user-agent and IP are
 *    never written anywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  countryFromRequest,
  parseUserAgent,
  parseUtm,
} from "../src/server/services/analytics-enrich";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ipad:
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1",
  macEdge:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  winFirefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  googlebot:
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

describe("parseUserAgent", () => {
  test("a Chromium browser is not mistaken for Safari", () => {
    // The trap: this UA contains BOTH `Safari/537.36` and `Chrome/124`, and
    // Edge additionally carries `Edg/`. Generic-first ordering returns Safari.
    expect(parseUserAgent(UA.macEdge)).toEqual({
      deviceType: "desktop",
      browser: "Edge",
      os: "macOS",
    });
    expect(parseUserAgent(UA.androidChrome).browser).toBe("Chrome");
    expect(parseUserAgent(UA.iphoneSafari).browser).toBe("Safari");
  });

  test("Android is not mistaken for Linux, iPad is not mistaken for macOS", () => {
    // Both UAs genuinely contain the wrong answer: Android says `Linux`, and
    // iPadOS says `like Mac OS X`.
    expect(parseUserAgent(UA.androidChrome).os).toBe("Android");
    expect(parseUserAgent(UA.ipad).os).toBe("iOS");
    expect(parseUserAgent(UA.winFirefox)).toEqual({
      deviceType: "desktop",
      browser: "Firefox",
      os: "Windows",
    });
  });

  test("a tablet is a tablet, not a phone", () => {
    // An Android tablet's UA is an Android phone's minus the `Mobile` token —
    // the only thing separating them.
    expect(parseUserAgent(UA.androidTablet).deviceType).toBe("tablet");
    expect(parseUserAgent(UA.ipad).deviceType).toBe("tablet");
    expect(parseUserAgent(UA.androidChrome).deviceType).toBe("mobile");
  });

  test("declared crawlers are labelled, not silently bucketed as desktop", () => {
    expect(parseUserAgent(UA.googlebot).deviceType).toBe("bot");
  });

  test("an unrecognized agent yields null rather than a guess", () => {
    // `null` means "not identified", which is a different claim from
    // `desktop`. Reports must show it as its own row.
    expect(parseUserAgent("some-internal-http-client/1.0")).toEqual({
      deviceType: null,
      browser: null,
      os: null,
    });
    expect(parseUserAgent(null)).toEqual({
      deviceType: null,
      browser: null,
      os: null,
    });
  });

  test("desktop is a conclusion, not an else-branch", () => {
    // Regression guard for a real defect found while smoke-testing: with
    // `else desktop`, every server-side SDK call, monitoring probe and
    // undeclared scraper landed in the desktop bucket. Locally that silently
    // added 100 phantom "desktop visitors" to the seeded fixture — and desktop
    // vs mobile share is exactly the number an operator acts on.
    for (const ua of ["node-fetch/1.0", "SomeInternalClient/2.1", "Java/17.0.1"]) {
      expect(parseUserAgent(ua).deviceType).toBeNull();
    }
    // Recognizing EITHER an OS or a browser is enough to conclude desktop.
    expect(parseUserAgent("Mozilla/5.0 (X11; CrOS x86_64) AppleWebKit/537.36")).toEqual({
      deviceType: "desktop",
      browser: null,
      os: "ChromeOS",
    });
  });
});

describe("parseUtm", () => {
  test("reads the three grouped-on tags off a path or an absolute URL", () => {
    expect(parseUtm("/pricing?utm_source=news&utm_medium=email&utm_campaign=q3")).toEqual({
      utmSource: "news",
      utmMedium: "email",
      utmCampaign: "q3",
    });
    expect(parseUtm("https://x.test/p?utm_source=ads").utmSource).toBe("ads");
  });

  test("a path with no query, or no utm keys, yields nulls not empty strings", () => {
    // An empty string would become its own row in a GROUP BY; null is skipped.
    expect(parseUtm("/pricing").utmSource).toBeNull();
    expect(parseUtm("/pricing?ref=x").utmSource).toBeNull();
    expect(parseUtm("/p?utm_source=").utmSource).toBeNull();
    expect(parseUtm(null).utmCampaign).toBeNull();
  });
});

describe("countryFromRequest", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://x.test/", { headers });

  test("reads whichever platform header is present", () => {
    expect(countryFromRequest(req({ "cf-ipcountry": "tr" }))).toBe("TR");
    expect(countryFromRequest(req({ "x-vercel-ip-country": "DE" }))).toBe("DE");
    expect(countryFromRequest(req({ "x-backlex-country": "GB" }))).toBe("GB");
  });

  test("decodes Netlify's base64 geo blob", () => {
    const geo = btoa(JSON.stringify({ country: { code: "FR" } }));
    expect(countryFromRequest(req({ "x-nf-geo": geo }))).toBe("FR");
    // Malformed must not throw — ingest cannot fail over a bad header.
    expect(countryFromRequest(req({ "x-nf-geo": "not-base64!!" }))).toBeNull();
  });

  test("Cloudflare's unresolved sentinels are not countries", () => {
    // `XX` is "could not resolve" and `T1` is a Tor exit node. Both would
    // otherwise show up as a country in every report.
    expect(countryFromRequest(req({ "cf-ipcountry": "XX" }))).toBeNull();
    expect(countryFromRequest(req({ "cf-ipcountry": "T1" }))).toBeNull();
    expect(countryFromRequest(req({}))).toBeNull();
  });

  test("prefers request.cf over the header when the Workers runtime supplies it", () => {
    const r = new Request("https://x.test/", {
      headers: { "cf-ipcountry": "US" },
    }) as Request & { cf?: unknown };
    Object.defineProperty(r, "cf", { value: { country: "JP" } });
    expect(countryFromRequest(r)).toBe("JP");
  });
});

describe("ingest wiring", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const track = (events: unknown[], headers: Record<string, string> = {}) =>
    h.fetch("/api/analytics/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ events }),
    });

  const rowFor = async (distinctId: string) => {
    const res = await h.fetch(
      `/api/admin/analytics/events?distinctId=${distinctId}&limit=1`,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as any).data[0];
  };

  test("the request's user-agent and country land on the row", async () => {
    expect(
      (
        await track([{ name: "page_view", distinctId: "e1", path: "/x" }], {
          "User-Agent": UA.androidChrome,
          "CF-IPCountry": "TR",
        })
      ).status,
    ).toBe(202);

    const row = await rowFor("e1");
    expect(row.deviceType).toBe("mobile");
    expect(row.browser).toBe("Chrome");
    expect(row.os).toBe("Android");
    expect(row.country).toBe("TR");
  });

  test("campaign tags are read off each event's own landing path", async () => {
    await track(
      [
        {
          name: "page_view",
          distinctId: "e2",
          path: "/lp?utm_source=newsletter&utm_medium=email&utm_campaign=launch",
        },
      ],
      { "User-Agent": UA.winFirefox },
    );
    const row = await rowFor("e2");
    expect(row.utmSource).toBe("newsletter");
    expect(row.utmMedium).toBe("email");
    expect(row.utmCampaign).toBe("launch");
  });

  test("a client cannot dictate its own device, and the raw UA is never stored", async () => {
    await track(
      [
        {
          name: "page_view",
          distinctId: "e3",
          // Not accepted by the input schema; asserted anyway because a future
          // widening of that schema must not quietly make it authoritative.
          deviceType: "desktop",
          browser: "Netscape",
        } as never,
      ],
      { "User-Agent": UA.iphoneSafari },
    );
    const row = await rowFor("e3");
    expect(row.deviceType).toBe("mobile");
    expect(row.browser).toBe("Safari");

    // The user-agent string itself is high-entropy enough to fingerprint, so it
    // is read and dropped. Nothing on the row may carry it.
    expect(JSON.stringify(row)).not.toContain("AppleWebKit");
  });

  test("rows default to the durable id scope", async () => {
    // Every row written today comes from the SDK's localStorage id. Phase 2's
    // cookieless tag is what starts writing 'daily'.
    await track([{ name: "page_view", distinctId: "e4" }]);
    expect((await rowFor("e4")).idScope).toBe("durable");
    expect((await rowFor("e4")).siteId).toBeNull();
  });

  test("the overview reports the new dimensions, with users not just hits", async () => {
    await track(
      [
        { name: "page_view", distinctId: "u1", path: "/a?utm_source=ads" },
        { name: "page_view", distinctId: "u1", path: "/a?utm_source=ads" },
        { name: "page_view", distinctId: "u2", path: "/a?utm_source=ads" },
      ],
      { "User-Agent": UA.macEdge, "CF-IPCountry": "DE" },
    );

    const now = Date.now();
    const res = await h.fetch(
      `/api/admin/analytics/overview?from=${now - 86_400_000}&to=${now}`,
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;

    const de = data.topCountries.find((r: any) => r.value === "DE");
    // Three hits from two people — the distinction the old shape could not make.
    expect(de.count).toBe(3);
    expect(de.users).toBe(2);

    expect(data.topDevices.some((r: any) => r.value === "desktop")).toBe(true);
    expect(data.topCampaigns.find((r: any) => r.value === "ads").users).toBe(2);
  });

  test("with no cookieless traffic the visitor figures agree and the share is zero", async () => {
    const now = Date.now();
    const { data } = (await (
      await h.fetch(
        `/api/admin/analytics/overview?from=${now - 86_400_000}&to=${now}`,
      )
    ).json()) as any;

    // Until the tag ships, every id is durable — so the headline `users` and
    // the always-true `durableUsers` must be the same number, and there is no
    // per-day figure to report.
    expect(data.totals.cookielessShare).toBe(0);
    expect(data.totals.durableUsers).toBe(data.totals.users);
    expect(data.totals.visitorsPerDay).toBeNull();
  });
});
