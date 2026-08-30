/**
 * The public consent ingest, driven the way an attacker drives it.
 *
 * This is the only uncredentialed WRITE in the consent feature: a POST from a
 * foreign origin, addressed by a site id that is public by design. So the cases
 * below are mostly abuse rather than happy path — forging a verdict, writing to
 * a site that never asked for a banner, and using the response as an oracle for
 * which site ids are real.
 *
 * The single most important property: **every deliberate drop answers exactly
 * like a success.** An unknown site, a disabled policy, a malformed body and
 * the operator's own capacity ceiling are all `202 {"ok":true}`. A caller can
 * learn one thing — back off — and nothing else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { getSiteById } from "../src/server/services/analytics";
import { listConsentVersions, savePolicy } from "../src/server/services/consent";
import { listConsentRecords } from "../src/server/services/consent-records";

let h: TestHarness;
let db: never;
let SITE = "";
let TENANT: string | null = null;
let HASH = "";

const SUBJECT = "visitor-aaaaaaaaaaaa";
const OK = '{"ok":true}';

const anon = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("Origin")) headers.set("Origin", "https://customer.example");
  if (!headers.has("X-Forwarded-For")) headers.set("X-Forwarded-For", "203.0.113.44");
  return Promise.resolve(h.app.fetch(new Request(`${h.env.APP_URL}${path}`, { ...init, headers })));
};

const post = (body: unknown, init: RequestInit = {}) =>
  anon("/api/consent/record", {
    method: "POST",
    // `text/plain` on purpose: it is what lets `sendBeacon` fire this during
    // page unload without a preflight there is no round-trip left for.
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

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

  SITE = await newSite("ingest");
  TENANT = (await getSiteById(db, SITE))!.tenantId;
  await savePolicy(db, TENANT, SITE, {
    undecidedBehaviour: "block",
    trackerCategory: "none",
    categoriesOffered: ["analytics", "marketing"],
    enabled: true,
  });
  HASH = (await listConsentVersions(db, TENANT, SITE))[0]!.hash;
});

afterAll(() => h.cleanup());

describe("a decision lands", () => {
  test("a banner post is recorded, graded and attributed", async () => {
    const res = await post({
      s: SITE,
      u: SUBJECT,
      h: HASH,
      g: { analytics: true, marketing: false },
      l: "en",
      src: "banner",
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(OK);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const rows = await listConsentRecords(db, TENANT, { siteId: SITE, subjectId: SUBJECT });
    expect(rows.length).toBe(1);
    expect(rows[0]!.decision).toBe("partial");
    expect(rows[0]!.grants).toEqual({ analytics: true, marketing: false });
    expect(rows[0]!.hashGrade).toBe("current");
    expect(rows[0]!.source).toBe("banner");
    expect(rows[0]!.locale).toBe("en");
  });

  test("the verdict cannot be forged from the body", async () => {
    // The attack: claim `granted` while granting nothing. The stored decision
    // must come from the grants, or a site's own log reports consent its own
    // grants contradict.
    const subject = "forger-aaaaaaaaaaaaa";
    await post({
      s: SITE,
      u: subject,
      h: HASH,
      g: { analytics: false, marketing: false },
      decision: "granted",
      hashGrade: "current",
    });
    const rows = await listConsentRecords(db, TENANT, { siteId: SITE, subjectId: subject });
    expect(rows[0]!.decision).toBe("denied");
  });

  test("a category the banner never offered cannot be consented to", async () => {
    const subject = "smuggler-aaaaaaaaaa";
    await post({
      s: SITE,
      u: subject,
      h: HASH,
      g: { analytics: true, marketing: true, sold_to_brokers: true },
    });
    const rows = await listConsentRecords(db, TENANT, { siteId: SITE, subjectId: subject });
    expect(Object.keys(rows[0]!.grants).sort()).toEqual(["analytics", "marketing"]);
  });
});

describe("every deliberate drop is indistinguishable from a success", () => {
  test("unknown, unconfigured and disabled sites all answer like an accepted write", async () => {
    const noPolicy = await newSite("ingest-nopolicy");
    const disabled = await newSite("ingest-disabled");
    const dTenant = (await getSiteById(db, disabled))!.tenantId;
    await savePolicy(db, dTenant, disabled, {
      undecidedBehaviour: "allow",
      trackerCategory: "none",
      enabled: false,
    });

    const bodies: unknown[] = [
      { s: "00000000-0000-4000-8000-000000000000", u: SUBJECT, g: {} },
      { s: noPolicy, u: SUBJECT, g: {} },
      { s: disabled, u: SUBJECT, g: {} },
      { s: SITE, u: "short", g: {} },
      { s: SITE, g: {} },
      { u: SUBJECT, g: {} },
      "not json at all",
      "",
    ];
    for (const body of bodies) {
      const res = await post(body);
      const label = JSON.stringify(body).slice(0, 40);
      expect(`${label} → ${res.status}`).toBe(`${label} → 202`);
      expect(`${label} → ${await res.text()}`).toBe(`${label} → ${OK}`);
    }

    // …and none of them wrote anything.
    expect((await listConsentRecords(db, dTenant, { siteId: disabled })).length).toBe(0);
    expect((await listConsentRecords(db, TENANT, { siteId: noPolicy })).length).toBe(0);
  });

  test("a site that never published a policy cannot be written to at all", async () => {
    // The gate that makes an uncredentialed write safe to ship before the
    // banner exists: the writable set is exactly the set of sites whose
    // operator deliberately enabled a consent policy.
    const quiet = await newSite("ingest-quiet");
    const qTenant = (await getSiteById(db, quiet))!.tenantId;
    for (let i = 0; i < 5; i++) {
      await post({ s: quiet, u: SUBJECT, g: { analytics: true } });
    }
    expect((await listConsentRecords(db, qTenant, { siteId: quiet })).length).toBe(0);
  });

  test("an oversize body is refused on its declared length, before it is read", async () => {
    const res = await post("x".repeat(9_000), {
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "Content-Length": "9000",
      },
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(OK);
  });
});

describe("withdrawal", () => {
  test("a visitor can remove their own record, and learns nothing either way", async () => {
    const subject = "quitter-aaaaaaaaaaaa";
    await post({ s: SITE, u: subject, h: HASH, g: { analytics: true } });
    expect(
      (await listConsentRecords(db, TENANT, { siteId: SITE, subjectId: subject })).length,
    ).toBe(1);

    const del = await anon(
      `/api/consent/record?s=${SITE}&u=${subject}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    expect(await del.text()).toBe('{"cleared":true}');
    expect(del.headers.get("access-control-allow-origin")).toBe("*");
    expect(
      (await listConsentRecords(db, TENANT, { siteId: SITE, subjectId: subject })).length,
    ).toBe(0);

    // A subject that never existed answers identically — a count here would say
    // whether a given id is real.
    const again = await anon(
      `/api/consent/record?s=${SITE}&u=nobody-aaaaaaaaaaaaa`,
      { method: "DELETE" },
    );
    expect(again.status).toBe(200);
    expect(await again.text()).toBe('{"cleared":true}');
  });

  test("one visitor cannot erase another's record", async () => {
    const mine = "mine-aaaaaaaaaaaaaaa";
    const theirs = "theirs-aaaaaaaaaaaaa";
    await post({ s: SITE, u: mine, h: HASH, g: { analytics: true } });
    await post({ s: SITE, u: theirs, h: HASH, g: { analytics: true } });

    await anon(`/api/consent/record?s=${SITE}&u=${mine}`, { method: "DELETE" });
    expect(
      (await listConsentRecords(db, TENANT, { siteId: SITE, subjectId: theirs })).length,
    ).toBe(1);
  });

  test("the DELETE preflight is answered, because it always preflights", async () => {
    // A method outside the CORS-safelisted set forces one. The POST deliberately
    // does not need it — that is why it takes `text/plain`.
    const res = await anon("/api/consent/record", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods") ?? "").toContain("DELETE");
  });
});

describe("CORS", () => {
  test("the write answers a foreign origin, not the app's own", async () => {
    // Without a `CORS_EXEMPT` entry the credentialed `cors()` replaces this
    // with one allowed origin and every banner on every customer domain fails.
    const res = await post({ s: SITE, u: SUBJECT, h: HASH, g: {} });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-origin")).not.toBe(h.env.APP_URL);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
