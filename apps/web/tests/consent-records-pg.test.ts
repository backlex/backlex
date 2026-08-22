/**
 * Postgres coverage for visitor consent records.
 *
 * Three things here are dialect-branched and none is visible from the SQLite
 * suite:
 *
 *  1. **`grants` is `jsonb` on Postgres and TEXT on SQLite.** The driver hands
 *     one back parsed and the other raw, so a reader that assumes either shape
 *     is broken on the other — and a malformed blob throws out of Drizzle's row
 *     mapper before any of our code runs, which on a listing is a 500 for the
 *     whole page over one bad row.
 *  2. **The prune compares a timestamp**, and `tsParam` binds a `Date` here
 *     against an epoch integer there. A `lt(created_at, cutoff)` that compares
 *     the wrong type silently deletes everything or nothing.
 *  3. **The erasure step deletes with `inArray` + `.returning()`**, whose
 *     generated SQL differs between the two.
 *
 * Follows `consent-versions-pg.test.ts`: pglite's WASM bundle is
 * environment-sensitive, so a harness that fails to boot degrades to a logged
 * skip rather than failing the whole suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let harness: PgTestHarness | undefined;
let SITE = "";

const SUBJECT = "pg-visitor-aaaaaaaaa";

const rowsOf = async (sql: string): Promise<any[]> => {
  const r = (await harness!.exec(sql)) as any;
  return (r?.rows ?? r) as any[];
};

const post = (body: unknown) =>
  harness!.app.fetch(
    new Request(`${harness!.env.APP_URL}/api/consent/record`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Origin: "https://customer.example",
        "X-Forwarded-For": "203.0.113.77",
      },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  harness = (await makeHarnessPgOrFail("consent-records-pg")) ?? undefined;
  if (!harness) return;
  const email = `pg-cr-${Date.now()}@example.test`;
  const signUp = await harness.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "A" }),
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const created = await harness.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "PG records", domain: "pg-records.example" }),
  });
  if (!created.ok) throw new Error(`site create failed: ${created.status}`);
  SITE = ((await created.json()) as any).data.id;

  const put = await harness.fetch(`/api/admin/consent/policies/${SITE}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      undecidedBehaviour: "block",
      trackerCategory: "none",
      categoriesOffered: ["analytics", "marketing"],
      enabled: true,
    }),
  });
  if (!put.ok) throw new Error(`policy save failed: ${put.status}`);
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test(
  "a decision written through the public route round-trips as jsonb",
  async () => {
    if (!harness) return;
    const res = await post({
      s: SITE,
      u: SUBJECT,
      g: { analytics: true, marketing: false },
      l: "tr",
      src: "banner",
    });
    expect(res.status).toBe(202);

    const rows = await rowsOf(
      `SELECT subject_id, decision, grants, source, locale, created_at
         FROM consent_records WHERE subject_id = '${SUBJECT}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe("partial");
    expect(rows[0].source).toBe("banner");
    expect(rows[0].locale).toBe("tr");

    // Postgres parses `jsonb`; SQLite returns TEXT. Assert on the VALUE rather
    // than the representation, and prove the clamp survived the round trip.
    const grants =
      typeof rows[0].grants === "string" ? JSON.parse(rows[0].grants) : rows[0].grants;
    expect(grants).toEqual({ analytics: true, marketing: false });
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "the verdict is still derived server-side on Postgres",
  async () => {
    if (!harness) return;
    // Same forgery attempt as the SQLite spec. It is re-run here because the
    // clamp and the derivation happen before the insert, and a dialect bug that
    // dropped `grants` would make `decision` read as `granted` on an empty map.
    const subject = "pg-forger-aaaaaaaaa";
    const res = await post({
      s: SITE,
      u: subject,
      g: { analytics: false, marketing: false },
      decision: "granted",
    });
    expect(res.status).toBe(202);
    const rows = await rowsOf(
      `SELECT decision FROM consent_records WHERE subject_id = '${subject}'`,
    );
    expect(rows[0].decision).toBe("denied");
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "the retention prune compares timestamps correctly against timestamptz",
  async () => {
    if (!harness) return;
    const { pruneConsentRecords } = await import("../src/server/services/consent-records");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(harness.env);
    const db = { db: ctx.db, dialect: ctx.dialect } as never;

    const subject = "pg-prune-aaaaaaaaaa";
    const now = Date.now();
    // Two rows straddling the cutoff, written straight in so their timestamps
    // are exact. `to_timestamp` takes seconds.
    for (const ageDays of [900, 10]) {
      await harness.exec(
        `INSERT INTO consent_records
           (id, tenant_id, site_id, subject_id, policy_hash, version_id, hash_grade,
            decision, grants, source, locale, country, ip_hash, user_agent, created_at)
         VALUES ('${crypto.randomUUID()}', NULL, '${SITE}', '${subject}', NULL, NULL,
                 'unresolved', 'denied', '{}'::jsonb, 'banner', NULL, NULL, NULL, NULL,
                 to_timestamp(${(now - ageDays * 86_400_000) / 1000}))`,
      );
    }
    expect((await rowsOf(`SELECT id FROM consent_records WHERE subject_id = '${subject}'`)).length).toBe(2);

    await pruneConsentRecords(db, now - 730 * 86_400_000);

    // Exactly the old one goes. A dialect mismatch on the comparison shows up
    // here as 0 or 2, never 1 — which is why the surviving row's AGE is
    // asserted rather than just the count.
    const left = await rowsOf(
      `SELECT created_at FROM consent_records WHERE subject_id = '${subject}'`,
    );
    expect(left.length).toBe(1);
    const survivorMs = new Date(left[0].created_at).getTime();
    expect(now - survivorMs).toBeLessThan(730 * 86_400_000);
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "erasure by consent id deletes on Postgres too",
  async () => {
    if (!harness) return;
    // `inArray` + `.returning()` generate different SQL per dialect, and this is
    // the only place the Postgres spelling runs. A failure here is a data-
    // subject request that reports a count it did not actually delete.
    const subject = "pg-erasure-aaaaaaaa";
    expect((await post({ s: SITE, u: subject, g: { analytics: true } })).status).toBe(202);
    expect((await post({ s: SITE, u: subject, g: { analytics: false } })).status).toBe(202);
    expect(
      (await rowsOf(`SELECT id FROM consent_records WHERE subject_id = '${subject}'`)).length,
    ).toBe(2);

    const made = await harness.fetch("/api/admin/erasure/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: { type: "consent_id", value: subject }, mode: "delete" }),
    });
    expect(made.status).toBe(201);
    const req = ((await made.json()) as any).data;
    expect(req.plan.counts.consent).toBe(2);

    const run = await harness.fetch(`/api/admin/erasure/${req.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: { type: "consent_id", value: subject }, confirm: true }),
    });
    expect(run.status).toBe(200);
    expect(((await run.json()) as any).data.report.counts.consent).toBe(2);
    expect(
      (await rowsOf(`SELECT id FROM consent_records WHERE subject_id = '${subject}'`)).length,
    ).toBe(0);
  },
  PGLITE_TEST_TIMEOUT_MS,
);
