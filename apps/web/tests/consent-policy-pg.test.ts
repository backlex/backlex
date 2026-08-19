/**
 * Postgres coverage for the consent policy.
 *
 * Two things here are dialect-branched and neither is visible from the SQLite
 * suite. `savePolicy` binds a `Date` on Postgres and epoch milliseconds on
 * SQLite, and the upsert is an `ON CONFLICT (site_id) DO UPDATE ... WHERE`
 * whose generated SQL differs between the two — the `setWhere` clause in
 * particular, which is what stops one tenant overwriting another's policy.
 *
 * A SQLite-only spec would ship a Postgres upsert nobody ever ran. So this one
 * asserts the same behaviours against a real Postgres, on the same fixture.
 *
 * Follows `analytics-pg.test.ts`: pglite's WASM bundle is environment-sensitive,
 * so a harness that fails to boot degrades to a logged skip rather than failing
 * the whole suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let harness: PgTestHarness | undefined;
let SITE = "";

beforeAll(async () => {
  harness = (await makeHarnessPgOrFail("consent-policy-pg")) ?? undefined;
  if (!harness) return;
  const email = `pg-consent-${Date.now()}@example.test`;
  const signUp = await harness.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "A" }),
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const created = await harness.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "PG consent", domain: "pg-consent.example" }),
  });
  if (!created.ok) throw new Error(`site create failed: ${created.status}`);
  SITE = ((await created.json()) as any).data.id;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test(
  "the posture cannot be acquired by omission on Postgres either",
  async () => {
    if (!harness) return;
    const res = await harness.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(422);
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "a full save round-trips, and the timestamps come back as numbers",
  async () => {
    if (!harness) return;
    // The dialect branch this catches: `tsParam` writes a `Date` against
    // `timestamptz` here and an integer against SQLite, while `tsValue` has to
    // read both back as epoch ms. A driver returning a string or a Date to the
    // JSON response would make every client's date arithmetic wrong.
    const put = await harness.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "block",
        trackerCategory: "none",
        categoriesOffered: ["marketing", "analytics"],
        policyUrl: "https://pg-consent.example/privacy",
        enabled: true,
        wording: { tr: { title: "Çerezler" } },
      }),
    });
    expect(put.status).toBe(200);
    const saved = ((await put.json()) as any).data;

    expect(saved.undecidedBehaviour).toBe("block");
    expect(saved.trackerCategory).toBe("none");
    // Stable order, not insertion order — the artifact hash in the next phase
    // depends on it.
    expect(saved.categoriesOffered).toEqual(["analytics", "marketing"]);
    expect(saved.wording.tr.title).toBe("Çerezler");
    expect(typeof saved.createdAt).toBe("number");
    expect(saved.createdAt).toBeGreaterThan(0);
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "the upsert updates in place rather than conflicting",
  async () => {
    if (!harness) return;
    // `ON CONFLICT (site_id) DO UPDATE` is spelled differently by the two
    // dialects and this is the only place it runs against Postgres. A broken
    // spelling surfaces as a duplicate-key 500 on the second save, which is
    // exactly what an operator does after their first typo.
    const second = await harness.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).data.enabled).toBe(false);
    // …and the posture it did not mention is still the one chosen before.
    const got = await harness.fetch(`/api/admin/consent/policies/${SITE}`);
    const data = ((await got.json()) as any).data;
    expect(data.undecidedBehaviour).toBe("block");

    const list = await harness.fetch("/api/admin/consent/policies");
    const rows = ((await list.json()) as any).data as any[];
    expect(rows.filter((p) => p.siteId === SITE).length).toBe(1);
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "the database refuses a bare insert on Postgres too",
  async () => {
    if (!harness) return;
    // The service's refusal is one layer; the NOT NULL with no DEFAULT is the
    // other, and a column default added by a careless migration would silently
    // remove it.
    // Straight at the database through the harness's raw `exec`, not through
    // an HTTP endpoint. Routed through the API this assertion goes vacuous the
    // moment the route is renamed: a 404 is "not 200" and would pass while
    // proving nothing about the column.
    let err: unknown = null;
    try {
      await harness.exec(
        "INSERT INTO consent_policies (site_id, created_at, updated_at) VALUES ('bare', now(), now())",
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    const text = `${(err as any)?.message ?? ""} ${(err as any)?.cause?.message ?? ""}`;
    // Postgres names the column in a not-null violation. Asserting the reason
    // is what separates this from a typo in the table name also throwing.
    expect(text).toContain("undecided_behaviour");
  },
  PGLITE_TEST_TIMEOUT_MS,
);
