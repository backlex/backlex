/**
 * Channel classification and session attribution.
 *
 * The classifier is pure, so most of this runs with no harness at all — which
 * is the point of keeping the rules out of the database. The cases below are
 * chosen to fail on a reordering rather than to enumerate the table.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  classifyChannel,
  referrerHost,
  sourceMediumLabel,
} from "../src/server/services/analytics-channels";
import {
  analyticsChannels,
  getSiteById,
  recordEvents,
} from "../src/server/services/analytics";

describe("classifyChannel", () => {
  test("a paid medium beats the referrer that looks organic", () => {
    // The expensive mistake: an ad click and an organic result share
    // `google.com` as a referrer and differ ONLY in the tag. Referrer-first
    // ordering files every paid campaign as free traffic.
    expect(
      classifyChannel({
        referrer: "https://www.google.com/",
        utmSource: "google",
        utmMedium: "cpc",
      }),
    ).toBe("Paid Search");
    expect(classifyChannel({ referrer: "https://www.google.com/" })).toBe(
      "Organic Search",
    );
  });

  test("search engines and social networks are recognized by host", () => {
    expect(classifyChannel({ referrer: "https://news.google.com/x" })).toBe(
      "Organic Search",
    );
    expect(classifyChannel({ referrer: "https://www.google.co.uk/search?q=a" })).toBe(
      "Organic Search",
    );
    expect(classifyChannel({ referrer: "https://t.co/abc" })).toBe("Organic Social");
    expect(classifyChannel({ referrer: "https://news.ycombinator.com/" })).toBe(
      "Organic Social",
    );
  });

  test("an unrecognized referrer is Referral, which is a correct answer", () => {
    // Falling through to Referral keeps the long-tail honest; guessing would
    // not. This is why the host lists can stay short.
    expect(classifyChannel({ referrer: "https://some-blog.example/post" })).toBe(
      "Referral",
    );
  });

  test("no referrer and no tag is Direct — but a tag alone is not", () => {
    expect(classifyChannel({})).toBe("Direct");
    expect(classifyChannel({ referrer: "" })).toBe("Direct");
    // Someone told us it came from somewhere, even if we don't recognize the
    // medium. Calling that Direct would credit an untracked campaign to nobody.
    expect(classifyChannel({ utmSource: "partner-site", utmMedium: "banner-x" })).toBe(
      "Referral",
    );
  });

  test("email, display and affiliate mediums each land", () => {
    expect(classifyChannel({ utmMedium: "email" })).toBe("Email");
    expect(classifyChannel({ utmMedium: "newsletter" })).toBe("Email");
    expect(classifyChannel({ utmMedium: "display" })).toBe("Display");
    expect(classifyChannel({ utmMedium: "affiliate" })).toBe("Affiliate");
    expect(classifyChannel({ utmMedium: "paid_social" })).toBe("Paid Social");
  });

  test("referrerHost tolerates junk rather than throwing", () => {
    expect(referrerHost("https://Example.COM/a/b")).toBe("example.com");
    expect(referrerHost("example.com")).toBe("example.com");
    expect(referrerHost("not a url at all")).toBeNull();
    expect(referrerHost(null)).toBeNull();
  });

  test("source / medium uses GA's own spelling for untagged direct", () => {
    expect(sourceMediumLabel({})).toBe("(direct) / (none)");
    expect(sourceMediumLabel({ referrer: "https://x.com/a" })).toBe("x.com / (none)");
    expect(sourceMediumLabel({ utmSource: "News", utmMedium: "Email" })).toBe(
      "news / email",
    );
  });
});

describe("session attribution", () => {
  const MIN = 60_000;
  const T0 = Date.parse("2026-08-18T08:00:00.000Z");
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
      body: JSON.stringify({ name: "Ch", domain: "ch.example" }),
    });
    SITE = ((await created.json()) as any).data.id;
    TENANT = (await getSiteById(db, SITE))!.tenantId;

    await recordEvents(
      db,
      TENANT,
      [
        // v1: arrives from Google, then browses. One session, Organic Search.
        { name: "page_view", distinctId: "v1", siteId: SITE, path: "/", referrer: "https://www.google.com/", ts: T0 },
        { name: "page_view", distinctId: "v1", siteId: SITE, path: "/pricing", ts: T0 + 2 * MIN },
        // v2: lands direct on a bookmark, THEN clicks an emailed link in the
        // same session. Ordering strictly by time would call this Direct.
        { name: "page_view", distinctId: "v2", siteId: SITE, path: "/", ts: T0 + 1 * MIN },
        { name: "page_view", distinctId: "v2", siteId: SITE, path: "/offer", utmSource: "news", utmMedium: "email", ts: T0 + 3 * MIN },
        // v3: an ad click. Same referrer host as v1, different channel.
        { name: "page_view", distinctId: "v3", siteId: SITE, path: "/lp", referrer: "https://www.google.com/", utmSource: "google", utmMedium: "cpc", ts: T0 + 4 * MIN },
        // v4: genuinely direct.
        { name: "page_view", distinctId: "v4", siteId: SITE, path: "/", ts: T0 + 5 * MIN },
      ],
      NOW,
    );
  });

  afterAll(() => h.cleanup());

  const run = () =>
    analyticsChannels(db, { tenantId: TENANT, from: T0 - MIN, to: NOW, siteId: SITE });

  test("each session is attributed to its non-direct touch", async () => {
    const r = await run();
    expect(r.totalSessions).toBe(4);

    const byName = Object.fromEntries(r.channels.map((c) => [c.channel, c.sessions]));
    expect(byName["Organic Search"]).toBe(1); // v1
    expect(byName["Email"]).toBe(1); // v2 — NOT Direct, despite landing direct
    expect(byName["Paid Search"]).toBe(1); // v3 — the tag beats the referrer
    expect(byName["Direct"]).toBe(1); // v4
  });

  test("source / medium mirrors the same attribution", async () => {
    const r = await run();
    const labels = r.sourceMedium.map((s) => s.value);
    expect(labels).toContain("news / email");
    expect(labels).toContain("google / cpc");
    expect(labels).toContain("(direct) / (none)");
    // v1's touch had a referrer but no tags, so its source is the host.
    expect(labels).toContain("www.google.com / (none)");
  });

  test("the REST surface is admin-only", async () => {
    const res = await h.fetch(
      `/api/admin/analytics/channels?from=${T0 - MIN}&to=${NOW}&siteId=${SITE}`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.totalSessions).toBe(4);

    const anon = makeHarness();
    try {
      expect((await anon.fetch("/api/admin/analytics/channels")).status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
