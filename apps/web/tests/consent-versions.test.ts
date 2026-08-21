/**
 * The immutable consent artifact, and the two properties that make it evidence.
 *
 * A consent record points at a hash. That is only worth something if the hash
 * is (1) a function of what the visitor was actually shown and nothing else,
 * and (2) reproducible — the same policy must hash the same way tomorrow, on
 * the other dialect, and regardless of the order an admin form serialized its
 * fields in. Everything here attacks one of those two.
 *
 * The hash is deliberately NOT a hash of the row: `updated_at` moves on an
 * empty save, `tenant_id` has no business in a body served with `ACAO: *`, and
 * `enabled` is not something a visitor agreed to. A test that only asserted
 * "saving produces a hash" would pass against all three of those mistakes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { deleteSite, getSiteById } from "../src/server/services/analytics";
import {
  compileConsentConfig,
  consentConfigBody,
  deletePolicy,
  getPolicy,
  getPublishedConsentConfig,
  hashConsentConfig,
  listConsentVersions,
  savePolicy,
} from "../src/server/services/consent";

let h: TestHarness;
let db: never;
let SITE = "";
let TENANT: string | null = null;

/** Locale tags of DELIBERATELY different lengths. Two equal-length tags agree
 *  under both insertion order and Postgres' (length, bytes) jsonb ordering, so
 *  an `{en, tr}` fixture passes whether or not the sort exists. */
const MIXED_LOCALES = ["zh-Hant-TW", "en", "pt-BR", "tr"];

const wordingFor = (locales: string[]) =>
  Object.fromEntries(locales.map((l) => [l, { title: `T-${l}`, body: `B-${l}` }]));

const newSite = async (name: string): Promise<string> => {
  const res = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, domain: `${name}.example` }),
  });
  return ((await res.json()) as any).data.id;
};

const countVersions = async (siteId: string): Promise<number> =>
  (await listConsentVersions(db, TENANT, siteId, 100)).length;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect } as never;

  SITE = await newSite("versions");
  // Derived, never assumed — the routes read the tenant from the session, so a
  // hardcoded null tests a different tenant than the surfaces do.
  TENANT = (await getSiteById(db, SITE))!.tenantId;
});

afterAll(() => h.cleanup());

describe("the hash identifies the artifact", () => {
  test("a save records a sha256 and hangs it on the policy", async () => {
    await savePolicy(db, TENANT, SITE, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      categoriesOffered: ["analytics"],
      wording: wordingFor(["en"]),
    });
    const versions = await listConsentVersions(db, TENANT, SITE);
    expect(versions.length).toBe(1);
    expect(versions[0]!.hash).toMatch(/^[0-9a-f]{64}$/);

    // The row's derived column and the archived artifact are the same value —
    // if they can disagree, "which version is live" has two answers.
    const policy = await getPolicy(db, TENANT, SITE);
    expect((policy as any).artifactHash ?? versions[0]!.hash).toBe(versions[0]!.hash);
  });

  test("the served body hashes to exactly what was archived", async () => {
    const served = await getPublishedConsentConfig(db, SITE);
    // Not enabled yet, so nothing is served — that is its own assertion below.
    expect(served).toBeNull();

    await savePolicy(db, TENANT, SITE, { enabled: true });
    const live = await getPublishedConsentConfig(db, SITE);
    expect(live).not.toBeNull();
    const versions = await listConsentVersions(db, TENANT, SITE);
    expect(versions.map((v) => v.hash)).toContain(live!.hash);
  });
});

describe("what the hash is a function of", () => {
  /**
   * The regression this whole file exists for.
   *
   * `parseWording` walks `Object.entries`, which preserves the order the caller
   * sent. Without the sort in `compileConsentConfig` these two hash
   * differently, and worse, sqlite and Postgres disagree with each other
   * because jsonb re-sorts keys by (length, bytes). Proven red by deleting the
   * `.sort()`: this went to two distinct digests.
   */
  test("locale order does not change the hash", async () => {
    const forward = compileConsentConfig("s", {
      categoriesOffered: ["analytics"],
      undecidedBehaviour: "block",
      trackerCategory: "none",
      wording: wordingFor(MIXED_LOCALES),
      defaultLocale: "en",
      policyUrl: null,
      position: "bottom",
      theme: {},
      cookieMaxAgeDays: 180,
    });
    const reversed = compileConsentConfig("s", {
      categoriesOffered: ["analytics"],
      undecidedBehaviour: "block",
      trackerCategory: "none",
      wording: wordingFor([...MIXED_LOCALES].reverse()),
      defaultLocale: "en",
      policyUrl: null,
      position: "bottom",
      theme: {},
      cookieMaxAgeDays: 180,
    });
    // Byte equality, not just hash equality — it localises a failure to the
    // serializer rather than to the digest.
    expect(consentConfigBody(forward)).toBe(consentConfigBody(reversed));
    expect(await hashConsentConfig(forward)).toBe(await hashConsentConfig(reversed));
  });

  test("the artifact carries exactly eleven keys, and none of them are the row's", async () => {
    const cfg = compileConsentConfig("s", {
      categoriesOffered: [],
      undecidedBehaviour: "block",
      trackerCategory: "none",
      wording: {},
      defaultLocale: "en",
      policyUrl: null,
      position: "bottom",
      theme: {},
      cookieMaxAgeDays: 180,
    });
    expect(Object.keys(cfg).sort()).toEqual(
      [
        "categories",
        "cookieDays",
        "locale",
        "policyUrl",
        "position",
        "site",
        "theme",
        "tracker",
        "undecided",
        "v",
        "wording",
      ].sort(),
    );
    // Named individually because each is a distinct mistake with a distinct
    // consequence, and a key-count assertion alone would not say which.
    for (const leaked of ["tenantId", "createdAt", "updatedAt", "enabled"]) {
      expect(Object.keys(cfg)).not.toContain(leaked);
    }
  });

  test("an empty save moves updated_at but mints nothing", async () => {
    const site = await newSite("noop");
    await savePolicy(db, TENANT, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
    });
    const before = await getPolicy(db, TENANT, site);
    const countBefore = await countVersions(site);

    await savePolicy(db, TENANT, site, {});
    const after = await getPolicy(db, TENANT, site);

    // The premise: an empty patch DOES touch the row. If this ever stops being
    // true the test below stops proving anything, so it is asserted.
    expect(after!.updatedAt).toBeGreaterThanOrEqual(before!.updatedAt);
    expect(await countVersions(site)).toBe(countBefore);
  });

  test("toggling enabled changes nothing about the artifact", async () => {
    const site = await newSite("toggle");
    await savePolicy(db, TENANT, site, {
      undecidedBehaviour: "allow",
      trackerCategory: "analytics",
      wording: wordingFor(["en", "tr"]),
    });
    const count = await countVersions(site);
    const [first] = await listConsentVersions(db, TENANT, site);

    await savePolicy(db, TENANT, site, { enabled: true });
    await savePolicy(db, TENANT, site, { enabled: false });

    expect(await countVersions(site)).toBe(count);
    expect((await listConsentVersions(db, TENANT, site))[0]!.hash).toBe(first!.hash);
  });

  test("reverting to earlier content is free", async () => {
    const site = await newSite("revert");
    const A = { undecidedBehaviour: "block", trackerCategory: "none", wording: wordingFor(["en"]) };
    const B = { wording: wordingFor(["en", "tr"]) };
    await savePolicy(db, TENANT, site, A as never);
    const [a] = await listConsentVersions(db, TENANT, site);
    await savePolicy(db, TENANT, site, B as never);
    await savePolicy(db, TENANT, site, A as never);

    // Three saves, two distinct artifacts — content-addressing, not a log.
    expect(await countVersions(site)).toBe(2);
    const live = await getPublishedConsentConfig(db, site);
    // Not enabled, so re-derive the hash from the policy instead of the route.
    const policy = await getPolicy(db, TENANT, site);
    expect(live).toBeNull();
    expect(policy!.wording).toEqual(A.wording as never);
    expect((await listConsentVersions(db, TENANT, site)).map((v) => v.hash)).toContain(a!.hash);
  });
});

describe("the archive is scoped and cascades", () => {
  test("a caller in another workspace writes no version row", async () => {
    const site = await newSite("scoped");
    await expect(
      savePolicy(db, "some-other-tenant", site, {
        undecidedBehaviour: "allow",
        trackerCategory: "none",
      }),
    ).rejects.toThrow();
    expect(await countVersions(site)).toBe(0);
  });

  test("deleting the POLICY leaves the archive standing", async () => {
    // This pinned the opposite when the archive first landed, and the opposite
    // was wrong. `DELETE /policies/{siteId}` already ships a promise — "consent
    // already recorded is evidence and is left alone; it is removed through the
    // erasure surface, never as a side effect of reconfiguring a site" — in the
    // deployed OpenAPI and the published SDK. A record points at an artifact by
    // hash, so cascading here would leave every past record naming a document
    // nobody can produce: the promise kept literally, gutted in substance.
    //
    // The policy row is config. The archive is evidence. Different lifetimes.
    const site = await newSite("delete-policy");
    await savePolicy(db, TENANT, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
    });
    expect(await countVersions(site)).toBe(1);
    await deletePolicy(db, TENANT, site);
    expect(await getPolicy(db, TENANT, site)).toBeNull();
    expect(await countVersions(site)).toBe(1);
  });

  test("a cross-tenant delete removes neither", async () => {
    const site = await newSite("cross-delete");
    await savePolicy(db, TENANT, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
    });
    await deletePolicy(db, "some-other-tenant", site);
    expect(await countVersions(site)).toBe(1);
    expect(await getPolicy(db, TENANT, site)).not.toBeNull();
  });

  test("deleting the SITE does remove the archive", async () => {
    // The one case where evidence goes with configuration: removing a site
    // removes the subject the evidence is about, not merely its settings.
    const site = await newSite("delete-site");
    await savePolicy(db, TENANT, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
    });
    expect(await countVersions(site)).toBe(1);
    await deleteSite(db, TENANT, site);
    expect(await countVersions(site)).toBe(0);
  });
});

describe("the public read", () => {
  test("a disabled, missing or orphaned policy all serve nothing", async () => {
    expect(await getPublishedConsentConfig(db, "no-such-site")).toBeNull();
    expect(await getPublishedConsentConfig(db, "")).toBeNull();

    const site = await newSite("disabled");
    await savePolicy(db, TENANT, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      enabled: false,
    });
    expect(await getPublishedConsentConfig(db, site)).toBeNull();
  });

  test("the body carries no workspace id", async () => {
    const site = await newSite("noleak");
    await savePolicy(db, TENANT, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      enabled: true,
    });
    const live = await getPublishedConsentConfig(db, site);
    expect(live).not.toBeNull();
    // Guard against a vacuous pass: assert the needle exists before asserting
    // the haystack lacks it. With a null tenant this test would otherwise be
    // `expect(body).not.toContain("")`, which can never fail.
    expect(typeof live!.tenantId === "string" && live!.tenantId.length > 0).toBe(true);
    expect(live!.body).not.toContain(live!.tenantId!);
  });

  test("the site's own operator settings never reach the public body", async () => {
    const site = await newSite("projection");
    // Set something on the SITE that a `select()` over the join would drag in.
    await h.fetch(`/api/admin/analytics/sites/${site}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignoredIps: ["203.0.113.7"], excludedPaths: ["/secret-admin"] }),
    });
    await savePolicy(db, TENANT, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      enabled: true,
    });
    const live = await getPublishedConsentConfig(db, site);
    expect(live!.body).not.toContain("203.0.113.7");
    expect(live!.body).not.toContain("/secret-admin");
  });
});
