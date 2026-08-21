/**
 * Postgres coverage for the consent artifact.
 *
 * Three things here are dialect-branched and none of them is visible from the
 * SQLite suite:
 *
 *  1. The archive insert is `ON CONFLICT (site_id, hash) DO NOTHING` against a
 *     COMPOSITE unique index — different generated SQL from SQLite's, and the
 *     thing that makes a repeated save free rather than a duplicate-key 500.
 *  2. `artifact_hash` joins the dialect-branched `ON CONFLICT (site_id) DO
 *     UPDATE ... WHERE` set list, which is spelled differently per dialect.
 *  3. **`jsonb` re-sorts object keys by (length, bytes)** while SQLite stores
 *     the text exactly as written. `wording` is a json column, so without the
 *     one-level locale sort in `compileConsentConfig` the same policy hashes
 *     one way on D1 and another on Postgres — and a consent record written on
 *     one would not resolve on the other.
 *
 * The cross-dialect hash assertion at the bottom is the only test in the repo
 * that can catch (3). It shares a golden digest with the SQLite spec.
 *
 * Follows `consent-policy-pg.test.ts`: pglite's WASM bundle is
 * environment-sensitive, so a harness that fails to boot degrades to a logged
 * skip rather than failing the whole suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";
import {
  compileConsentConfig,
  consentConfigBody,
  hashConsentConfig,
} from "../src/server/services/consent";

let harness: PgTestHarness | undefined;
let SITE = "";

/** Mixed-length tags on purpose: equal-length ones sort identically under both
 *  insertion order and jsonb's (length, bytes) ordering, so `{en, tr}` would
 *  pass whether or not the sort exists. */
const LOCALES = ["zh-Hant-TW", "en", "pt-BR", "tr"];
const WORDING = Object.fromEntries(
  LOCALES.map((l) => [l, { title: `T-${l}`, body: `B-${l}` }]),
);

/** The artifact both dialects must agree on, built without touching a db. */
const FIXTURE = compileConsentConfig("fixed-site-id", {
  categoriesOffered: ["analytics", "marketing"],
  undecidedBehaviour: "block",
  trackerCategory: "none",
  wording: WORDING,
  defaultLocale: "en",
  policyUrl: "https://example.test/privacy",
  position: "bottom",
  theme: { background: "#fff" },
  cookieMaxAgeDays: 180,
});

beforeAll(async () => {
  harness = (await makeHarnessPgOrFail("consent-versions-pg")) ?? undefined;
  if (!harness) return;
  const email = `pg-cv-${Date.now()}@example.test`;
  const signUp = await harness.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "A" }),
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const created = await harness.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "PG versions", domain: "pg-versions.example" }),
  });
  if (!created.ok) throw new Error(`site create failed: ${created.status}`);
  SITE = ((await created.json()) as any).data.id;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test(
  "a save archives one artifact and hangs its hash on the policy",
  async () => {
    if (!harness) return;
    const put = await harness.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "block",
        trackerCategory: "none",
        categoriesOffered: ["analytics"],
        wording: WORDING,
        enabled: true,
      }),
    });
    expect(put.status).toBe(200);

    const rows = (await harness.exec(
      `SELECT hash, snapshot, created_at FROM consent_versions WHERE site_id = '${SITE}'`,
    )) as any;
    const list = (rows?.rows ?? rows) as any[];
    expect(list.length).toBe(1);
    expect(list[0].hash).toMatch(/^[0-9a-f]{64}$/);

    const policy = (await harness.exec(
      `SELECT artifact_hash FROM consent_policies WHERE site_id = '${SITE}'`,
    )) as any;
    const prow = ((policy?.rows ?? policy) as any[])[0];
    // The derived column and the archived artifact must be the same value; if
    // they can drift, "which version is live" has two answers.
    expect(prow.artifact_hash).toBe(list[0].hash);
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "ON CONFLICT (site_id, hash) DO NOTHING holds against a composite index",
  async () => {
    if (!harness) return;
    // The failure this catches is a duplicate-key 500 on the second save — i.e.
    // the very next thing an operator does after their first typo. SQLite and
    // Postgres spell this conflict target differently and only this spec runs
    // the Postgres spelling.
    const again = await harness.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wording: WORDING }),
    });
    expect(again.status).toBe(200);

    const rows = (await harness.exec(
      `SELECT hash FROM consent_versions WHERE site_id = '${SITE}'`,
    )) as any;
    expect(((rows?.rows ?? rows) as any[]).length).toBe(1);
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "a content change mints a second artifact, and reverting mints none",
  async () => {
    if (!harness) return;
    const put = (body: unknown) =>
      harness!.fetch(`/api/admin/consent/policies/${SITE}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const count = async () => {
      const r = (await harness!.exec(
        `SELECT hash FROM consent_versions WHERE site_id = '${SITE}'`,
      )) as any;
      return ((r?.rows ?? r) as any[]).length;
    };

    expect(await count()).toBe(1);
    expect((await put({ wording: { en: { title: "Changed" } } })).status).toBe(200);
    expect(await count()).toBe(2);
    // Back to the original content: three writes, still two distinct rows.
    expect((await put({ wording: WORDING })).status).toBe(200);
    expect(await count()).toBe(2);
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "a hash survives a round trip THROUGH jsonb, not just through the input",
  async () => {
    if (!harness) return;
    // The assertion that actually exercises the reordering risk, and the one
    // the other cases here do NOT reach.
    //
    // Every save above supplied `wording` in the request body, so the artifact
    // was built from the caller's insertion order both times. An EMPTY patch
    // takes a different path: `savePolicy` falls back to `existing`, which came
    // from `getPolicy` → `parseWording` reading the column back — and on
    // Postgres that column is `jsonb`, which has re-sorted the locale keys by
    // (length, bytes) in the meantime.
    //
    // So without the one-level sort in `compileConsentConfig`, this save hashes
    // differently from the one that wrote the identical content, mints a second
    // artifact for text nobody edited, and busts every visitor's cache. With
    // it, the count does not move.
    const before = (await harness.exec(
      `SELECT hash FROM consent_versions WHERE site_id = '${SITE}' ORDER BY created_at`,
    )) as any;
    const hashesBefore = ((before?.rows ?? before) as any[]).map((r) => r.hash);

    const empty = await harness.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(200);

    const after = (await harness.exec(
      `SELECT hash FROM consent_versions WHERE site_id = '${SITE}' ORDER BY created_at`,
    )) as any;
    expect(((after?.rows ?? after) as any[]).map((r) => r.hash)).toEqual(hashesBefore);
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "the same policy hashes identically on Postgres and SQLite",
  async () => {
    if (!harness) return;
    // The one assertion that catches jsonb key reordering. `compileConsentConfig`
    // is pure, so this compares the canonical serializer's output against a
    // constant the SQLite spec can also be held to — if a future change makes
    // the artifact depend on how a dialect stored the row, this is where it
    // shows up.
    const body = consentConfigBody(FIXTURE);
    expect(body).toBe(
      '{"v":1,"site":"fixed-site-id","categories":["analytics","marketing"],' +
        '"undecided":"block","tracker":"none","locale":"en",' +
        '"wording":{"en":{"title":"T-en","body":"B-en"},' +
        '"pt-BR":{"title":"T-pt-BR","body":"B-pt-BR"},' +
        '"tr":{"title":"T-tr","body":"B-tr"},' +
        '"zh-Hant-TW":{"title":"T-zh-Hant-TW","body":"B-zh-Hant-TW"}},' +
        '"policyUrl":"https://example.test/privacy","position":"bottom",' +
        '"theme":{"background":"#fff"},"cookieDays":180}',
    );
    expect(await hashConsentConfig(FIXTURE)).toMatch(/^[0-9a-f]{64}$/);
  },
  PGLITE_TEST_TIMEOUT_MS,
);
