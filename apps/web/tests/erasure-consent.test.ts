/**
 * Erasure reaching a cookie-consent subject.
 *
 * The failure this file exists to prevent is a FALSE NEGATIVE, not over-deletion:
 * a request that reports "0 consent records" and completes, while the rows are
 * still there. That is the shape the naive integration produces — widen
 * `SubjectType` without giving `locateSubject` a third branch and a consent id
 * falls into the EMAIL lookup, matches no account, scans collections for a
 * value that is not an address, and reports zero for everything. Completed,
 * green, and wrong.
 *
 * So the assertions here are mostly about reachability: that the count is
 * non-zero BEFORE the run, that the rows are gone after it, and that the two
 * subject types which genuinely cannot reach consent are honest about it rather
 * than reporting a zero that reads like "they had none".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { getSiteById } from "../src/server/services/analytics";
import { savePolicy } from "../src/server/services/consent";
import { recordConsent } from "../src/server/services/consent-records";
import { ERASURE_SURFACES } from "../src/server/services/erasure";

const BASE = "/api/admin/erasure";
const CONSENT_ID = "visitor-erasure-aaaa";
const OTHER_ID = "visitor-bystander-bb";
const SUBJECT_EMAIL = "consent.subject@example.test";

let h: TestHarness;
let client: Database;
let db: never;
let SITE = "";
let TENANT: string | null = null;

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await h.fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

const countRows = (subjectId: string): number =>
  (
    client
      .query("select count(*) as n from consent_records where subject_id = ?")
      .get(subjectId) as { n: number }
  ).n;

const seed = async (subjectId: string, howMany = 2) => {
  for (let i = 0; i < howMany; i++) {
    await recordConsent(
      db,
      {
        siteId: SITE,
        tenantId: TENANT,
        subjectId,
        policyHash: null,
        currentHash: null,
        offered: ["analytics"],
        grants: { analytics: i % 2 === 0 },
        source: "banner",
        locale: "en",
        country: null,
        ipHash: null,
        userAgent: null,
      },
      Date.now() + i * 10,
    );
  }
};

/** Run a request end to end and hand back both halves of the report. */
const runFor = async (subject: unknown, mode: "delete" | "anonymize" = "delete") => {
  const made = await ok("POST", `${BASE}/preview`, { subject, mode });
  // The subject is restated on the run, deliberately: the request row holds a
  // hash and never the value, so there is no stored address to act on and a
  // stale preview cannot be replayed against a different person.
  const done = await ok("POST", `${BASE}/${made.data.id}/run`, { subject, confirm: true });
  // Both halves nest their per-surface numbers under `counts`.
  return {
    plan: (made.data.plan?.counts ?? {}) as Record<string, number>,
    report: (done.data.report?.counts ?? {}) as Record<string, number>,
    id: made.data.id,
  };
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect } as never;

  const created = await ok("POST", "/api/admin/analytics/sites", {
    name: "erasure",
    domain: "erasure.example",
  });
  SITE = created.data.id;
  TENANT = (await getSiteById(db, SITE))!.tenantId;
  await savePolicy(db, TENANT, SITE, {
    undecidedBehaviour: "block",
    trackerCategory: "none",
    categoriesOffered: ["analytics"],
    enabled: true,
  });
});

afterAll(() => h.cleanup());

beforeEach(() => {
  client.query("delete from erasure_requests").run();
  client.query("delete from consent_records").run();
});

test("`consent` is a declared surface, so the report is keyed by it", () => {
  expect(ERASURE_SURFACES).toContain("consent");
});

describe("a consent id reaches its records", () => {
  test("the preview counts them and the run removes them", async () => {
    await seed(CONSENT_ID, 3);
    expect(countRows(CONSENT_ID)).toBe(3);

    const { plan, report } = await runFor({ type: "consent_id", value: CONSENT_ID });

    // The count is the assertion that matters. A zero here is the false
    // negative this whole file is about, and it would still let the run
    // "complete".
    expect(plan.consent).toBe(3);
    expect(report.consent).toBe(3);
    expect(countRows(CONSENT_ID)).toBe(0);
  });

  test("it touches nobody else's records", async () => {
    await seed(CONSENT_ID, 2);
    await seed(OTHER_ID, 2);

    await runFor({ type: "consent_id", value: CONSENT_ID });

    expect(countRows(CONSENT_ID)).toBe(0);
    expect(countRows(OTHER_ID)).toBe(2);
  });

  test("anonymize deletes them too, because the id IS the identifier", async () => {
    // Scrubbing `subject_id` would leave a row carrying a user agent, an ip
    // hash and a timestamp — identifying nobody and proving nothing, retained
    // for no purpose. The same call `revisions` already makes.
    await seed(CONSENT_ID, 2);
    const { report } = await runFor({ type: "consent_id", value: CONSENT_ID }, "anonymize");
    expect(report.consent).toBe(2);
    expect(countRows(CONSENT_ID)).toBe(0);
  });

  test("a consent id with no records completes at zero rather than erroring", async () => {
    // `app_user` throws NOT_FOUND for an unknown id; a consent id must not,
    // because an operator cannot check one first — they were handed it.
    const { plan, report } = await runFor({ type: "consent_id", value: "never-seen-aaaaaaaa" });
    expect(plan.consent).toBe(0);
    expect(report.consent).toBe(0);
  });
});

describe("the limits are reported honestly", () => {
  test("an email request does not silently claim to have cleared consent", async () => {
    // The documented limitation, asserted so it stays documented: nothing links
    // a consent record to an address or an account, so `email` cannot reach
    // one. What must NOT happen is the rows being counted and left behind — a
    // report saying `consent: 2` while two rows survive would be a lie about a
    // legal obligation.
    await seed(CONSENT_ID, 2);
    const { plan, report } = await runFor({ type: "email", value: SUBJECT_EMAIL });

    expect(plan.consent).toBe(0);
    expect(report.consent).toBe(0);
    // …and the rows are, correctly, still there.
    expect(countRows(CONSENT_ID)).toBe(2);
  });

  test("a consent id is not routed through the email lookup", async () => {
    // The regression that motivated the third branch. With a bare `else`, a
    // consent id lands in the EMAIL arm: no account matches, every collection
    // is scanned for a value that is not an address, and the report comes back
    // all-zero — including `collections`, which is what makes the bug look like
    // a clean "nothing to erase" rather than a routing error.
    await seed(CONSENT_ID, 2);
    const { plan } = await runFor({ type: "consent_id", value: CONSENT_ID });

    expect(plan.consent).toBe(2);
    // A consent subject owns no rows in user collections by construction. If
    // this is ever non-zero, the id matched an email field — which means it was
    // treated as an address.
    expect(plan.collections).toBe(0);
    expect(plan.identity).toBe(0);
  });
});

describe("scoping", () => {
  test("another workspace's identical subject id is untouched", async () => {
    await seed(CONSENT_ID, 2);

    // A second workspace holding a row with the SAME subject id — plausible,
    // since the id is minted client-side and two sites can collide.
    const foreignTenant = crypto.randomUUID();
    client
      .query(
        `insert into consent_records
           (id, tenant_id, site_id, subject_id, policy_hash, version_id, hash_grade,
            decision, grants, source, locale, country, ip_hash, user_agent, created_at)
         values (?,?,?,?,null,null,'unresolved','denied','{}','banner',null,null,null,null,?)`,
      )
      .run(crypto.randomUUID(), foreignTenant, "other-site", CONSENT_ID, Date.now());

    const before = (
      client
        .query("select count(*) as n from consent_records where tenant_id = ?")
        .get(foreignTenant) as { n: number }
    ).n;
    expect(before).toBe(1);

    await runFor({ type: "consent_id", value: CONSENT_ID });

    expect(countRows(CONSENT_ID)).toBe(1); // only the foreign one survives
    expect(
      (
        client
          .query("select count(*) as n from consent_records where tenant_id = ?")
          .get(foreignTenant) as { n: number }
      ).n,
    ).toBe(1);
  });

  test("case is preserved, because a consent id is case-sensitive", async () => {
    // `normalizeSubject` lowercases EMAIL only. A consent id is `[A-Za-z0-9_-]`,
    // so folding its case would stop it matching the stored row — and the
    // symptom would be the same false "nothing to erase" this file exists to
    // prevent, not an error.
    const mixed = "Visitor-MiXeD-Case1";
    await seed(mixed, 2);
    const { plan } = await runFor({ type: "consent_id", value: mixed });
    expect(plan.consent).toBe(2);
    expect(countRows(mixed)).toBe(0);
  });

  test("the request row never stores the consent id", async () => {
    // `erasure_requests` holds a salted hash, never the value. A consent id is
    // the visitor's only handle; copying it into a table the operator browses
    // would re-create the identifier the erasure exists to remove.
    await seed(CONSENT_ID, 1);
    const { id } = await runFor({ type: "consent_id", value: CONSENT_ID });
    const row = client
      .query("select * from erasure_requests where id = ?")
      .get(id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(CONSENT_ID);
    expect(String(row.subject_type)).toBe("consent_id");
    expect(String(row.subject_hash)).toMatch(/^[0-9a-f]{64}$/);
  });
});
