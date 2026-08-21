/**
 * Visitor consent decisions — the evidence half.
 *
 * The banner runs on a page backlex does not control and carries no credential,
 * so every byte of the body is attacker-shaped. Most of this file attacks the
 * three things that are therefore NOT read from it: the verdict is derived from
 * the grants, the grants are clamped to the categories the policy actually
 * offered, and the tenant comes from the site.
 *
 * The other half is the append-only claim. It is worth testing mechanically
 * rather than trusting, because "evidence" is exactly the kind of word that
 * survives in a comment long after the code stopped honouring it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { deleteSite, getSiteById } from "../src/server/services/analytics";
import { listConsentVersions, savePolicy } from "../src/server/services/consent";
import {
  clampGrants,
  consentIpHash,
  countSubjectRecords,
  deleteSubjectRecords,
  deriveDecision,
  listConsentRecords,
  pruneConsentRecords,
  recordConsent,
} from "../src/server/services/consent-records";

let h: TestHarness;
let db: never;
let SITE = "";
let TENANT: string | null = null;
let HASH = "";

const SUBJECT = "aaaaaaaaaaaaaaaaaaaa";

/** A distinct subject per test. Sharing one made every count assertion measure
 *  the rows earlier tests had written, which is how two of these first went
 *  red against correct code. Padded to clear `SUBJECT_ID_RE`'s 16-char floor. */
let n = 0;
const freshSubject = () => `subj${(n += 1)}`.padEnd(20, "x");

const newSite = async (name: string): Promise<string> => {
  const res = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, domain: `${name}.example` }),
  });
  return ((await res.json()) as any).data.id;
};

const write = (over: Record<string, unknown> = {}) =>
  recordConsent(db, {
    siteId: SITE,
    tenantId: TENANT,
    subjectId: SUBJECT,
    policyHash: HASH,
    currentHash: HASH,
    offered: ["analytics", "marketing"],
    grants: { analytics: true, marketing: true },
    source: "banner",
    locale: "en",
    country: "TR",
    ipHash: null,
    userAgent: "probe",
    ...(over as any),
  });

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect } as never;

  SITE = await newSite("records");
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

describe("nothing the caller claims about itself is trusted", () => {
  test("the verdict is derived from the grants, not read from the body", async () => {
    // The attack: a body that says "granted" while granting nothing. If the
    // decision were taken from the request, a site's own log would report
    // consent that its own grants contradict.
    const denied = await write({
      grants: { analytics: false, marketing: false },
      decision: "granted",
    });
    expect(denied.decision).toBe("denied");

    const partial = await write({ grants: { analytics: true, marketing: false } });
    expect(partial.decision).toBe("partial");

    const granted = await write({ grants: { analytics: true, marketing: true } });
    expect(granted.decision).toBe("granted");
  });

  test("grants are clamped to what the policy actually offered", () => {
    // Unknown keys are dropped rather than rejected — bots pad payloads, and a
    // 422 would teach them which keys are real.
    expect(
      clampGrants({ analytics: true, marketing: true, sold_to_brokers: true }, [
        "analytics",
      ]),
    ).toEqual({ analytics: true });

    // A category the artifact OFFERED but the body omitted is false. Absence is
    // not consent — this is the single most important line in the clamp.
    expect(clampGrants({ analytics: true }, ["analytics", "marketing"])).toEqual({
      analytics: true,
      marketing: false,
    });

    // Truthy-but-not-true is not consent either.
    expect(clampGrants({ analytics: "yes", marketing: 1 }, ["analytics", "marketing"])).toEqual(
      { analytics: false, marketing: false },
    );

    for (const junk of [null, undefined, "granted", [], 42]) {
      expect(clampGrants(junk, ["analytics"])).toEqual({ analytics: false });
    }
  });

  test("a policy that offers nothing records `granted`, not `denied`", () => {
    // There was nothing to withhold. Reporting a site that asked for nothing as
    // one that was refused would be a lie in the operator's own log.
    expect(deriveDecision({})).toBe("granted");
  });
});

describe("the hash is graded, never enforced", () => {
  test("current, archived and unresolved are three different answers", async () => {
    const current = await write({ policyHash: HASH, currentHash: HASH });
    expect(current.hashGrade).toBe("current");

    // A second artifact, so the first becomes a real-but-superseded one.
    await savePolicy(db, TENANT, SITE, { policyUrl: "https://records.example/v2" });
    const now = (await listConsentVersions(db, TENANT, SITE)).map((v) => v.hash);
    expect(now.length).toBe(2);
    const live = now[0]!;
    const old = now.find((x) => x !== live)!;

    const archived = await write({ policyHash: old, currentHash: live });
    expect(archived.hashGrade).toBe("archived");

    // Never seen. Accepted anyway: refusing does not un-consent anyone, it only
    // destroys the evidence while the site keeps behaving as consented.
    const unknown = await write({ policyHash: "f".repeat(64), currentHash: live });
    expect(unknown.hashGrade).toBe("unresolved");

    // …and a malformed or absent hash is graded, not thrown on.
    expect((await write({ policyHash: null })).hashGrade).toBe("unresolved");
    expect((await write({ policyHash: "not-a-hash" })).hashGrade).toBe("unresolved");
  });

  test("another site's real hash does not resolve here", async () => {
    // Resolution is scoped to the site. Without that, a hash lifted from one
    // public config endpoint would grade as genuine evidence on someone else's.
    const other = await newSite("records-other");
    const otherTenant = (await getSiteById(db, other))!.tenantId;
    await savePolicy(db, otherTenant, other, {
      undecidedBehaviour: "allow",
      trackerCategory: "none",
      enabled: true,
    });
    const foreign = (await listConsentVersions(db, otherTenant, other))[0]!.hash;
    expect(foreign).toMatch(/^[0-9a-f]{64}$/);
    expect((await write({ policyHash: foreign })).hashGrade).toBe("unresolved");
  });
});

describe("append-only", () => {
  test("the service exports no update path", () => {
    // Mechanical, because "we agreed not to" is not a constraint: an update
    // reaching this table is how an edited decision ships.
    //
    // Comments are stripped first, and that is not a nicety — the module's own
    // header describes this rule in prose and contains the very call it forbids,
    // so a naive scan fails against a correct file. A check that cries wolf on
    // its own documentation is a check people delete.
    const raw = readFileSync(
      resolve(import.meta.dir, "..", "src", "server", "services", "consent-records.ts"),
      "utf8",
    );
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The premise: stripping left real code behind. Otherwise this passes on an
    // empty string.
    expect(code).toContain("recordConsent");
    expect(code).not.toContain(".update(");
    expect(code).not.toContain("onConflictDoUpdate");
  });

  test("a change of mind is a new row, and the latest one stands", async () => {
    const site = await newSite("mindchange");
    const tenant = (await getSiteById(db, site))!.tenantId;
    await savePolicy(db, tenant, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      categoriesOffered: ["analytics"],
      enabled: true,
    });
    const base = {
      siteId: site,
      tenantId: tenant,
      subjectId: freshSubject(),
      policyHash: null,
      currentHash: null,
      offered: ["analytics"] as const,
      source: "banner" as const,
      locale: "en",
      country: null,
      ipHash: null,
      userAgent: null,
    };
    // Spaced, because `created_at` is the tiebreak and this repo has already
    // had a flake from three rows sharing a millisecond. RECENT, too: an epoch
    // of 1_000 is 1970, which any retention window sweeps — a fixture in the
    // distant past is not neutral, it is a row every prune test also sees.
    const t0 = Date.now();
    await recordConsent(db, { ...base, grants: { analytics: true } }, t0);
    await recordConsent(db, { ...base, grants: { analytics: false } }, t0 + 50);

    const rows = await listConsentRecords(db, tenant, { siteId: site });
    expect(rows.length).toBe(2);
    expect(rows[0]!.decision).toBe("denied");
    expect(rows[0]!.createdAt).toBe(t0 + 50);
  });
});

describe("the address is a salted digest, or nothing", () => {
  test("it is stable, salted per workspace, and absent for an unknown caller", async () => {
    const a = await consentIpHash(h.env, "tenant-a", "203.0.113.7");
    const b = await consentIpHash(h.env, "tenant-a", "203.0.113.7");
    const c = await consentIpHash(h.env, "tenant-b", "203.0.113.7");

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Stable, or two visits by one visitor could not be correlated at all.
    expect(a).toBe(b);
    // Salted per workspace, so a digest cannot be carried between them.
    expect(a).not.toBe(c);
    // …and it is not a bare SHA-256 of the address, which is reversible: there
    // are only 2^32 IPv4 addresses.
    const bare = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("203.0.113.7")),
      ),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    expect(a).not.toBe(bare);

    expect(await consentIpHash(h.env, "tenant-a", null)).toBeNull();
    expect(await consentIpHash(h.env, "tenant-a", "unknown")).toBeNull();
  });

  test("the admin listing never projects it", async () => {
    await write({ ipHash: await consentIpHash(h.env, TENANT, "198.51.100.4") });
    const rows = await listConsentRecords(db, TENANT, { siteId: SITE });
    expect(rows.length).toBeGreaterThan(0);
    // It exists so two records can be correlated during an investigation, not
    // so an operator browsing a list reads a per-visitor identifier off screen
    // — where it ends up in a screenshot, a spreadsheet and a support ticket.
    expect(Object.keys(rows[0]!)).not.toContain("ipHash");
    expect(JSON.stringify(rows)).not.toContain("198.51.100.4");
  });
});

describe("removal", () => {
  test("a subject's decisions are removed, tenant-scoped, and counted", async () => {
    const site = await newSite("removal");
    const tenant = (await getSiteById(db, site))!.tenantId;
    await savePolicy(db, tenant, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      enabled: true,
    });
    const subject = freshSubject();
    const base = {
      siteId: site,
      tenantId: tenant,
      subjectId: subject,
      policyHash: null,
      currentHash: null,
      offered: [] as const,
      grants: {},
      source: "banner" as const,
      locale: null,
      country: null,
      ipHash: null,
      userAgent: null,
    };
    const t0 = Date.now();
    await recordConsent(db, base, t0);
    await recordConsent(db, base, t0 + 50);
    expect(await countSubjectRecords(db, tenant, subject)).toBe(2);

    // Another workspace cannot reach them — the subject id travels in a cookie
    // on a public page, so an unscoped delete would be a cross-tenant primitive.
    expect(await deleteSubjectRecords(db, "some-other-tenant", subject, site)).toBe(0);
    expect(await deleteSubjectRecords(db, tenant, subject, site)).toBe(2);
    expect(await countSubjectRecords(db, tenant, subject)).toBe(0);
  });

  test("deleting the site takes its records with it", async () => {
    const site = await newSite("site-gone");
    const tenant = (await getSiteById(db, site))!.tenantId;
    await savePolicy(db, tenant, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      enabled: true,
    });
    await recordConsent(db, {
      siteId: site,
      tenantId: tenant,
      subjectId: freshSubject(),
      policyHash: null,
      currentHash: null,
      offered: [],
      grants: {},
      source: "banner",
      locale: null,
      country: null,
      ipHash: null,
      userAgent: null,
    });
    expect((await listConsentRecords(db, tenant, { siteId: site })).length).toBe(1);
    await deleteSite(db, tenant, site);
    expect((await listConsentRecords(db, tenant, { siteId: site })).length).toBe(0);
  });

  test("the prune drops only what is past the window", async () => {
    const site = await newSite("prune");
    const tenant = (await getSiteById(db, site))!.tenantId;
    await savePolicy(db, tenant, site, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      enabled: true,
    });
    const base = {
      siteId: site,
      tenantId: tenant,
      subjectId: freshSubject(),
      policyHash: null,
      currentHash: null,
      offered: [] as const,
      grants: {},
      source: "banner" as const,
      locale: null,
      country: null,
      ipHash: null,
      userAgent: null,
    };
    const now = Date.now();
    await recordConsent(db, base, now - 900 * 86_400_000);
    await recordConsent(db, base, now - 10 * 86_400_000);

    // Asserted against THIS site, not the prune's global return value: other
    // tests in this file write rows too, so a global count measures them.
    expect((await listConsentRecords(db, tenant, { siteId: site })).length).toBe(2);
    expect(await pruneConsentRecords(db, now - 730 * 86_400_000)).toBeGreaterThan(0);
    const left = await listConsentRecords(db, tenant, { siteId: site });
    expect(left.length).toBe(1);
    // The survivor is the recent one, not merely "one row".
    expect(left[0]!.createdAt).toBeGreaterThan(now - 730 * 86_400_000);
  });
});
