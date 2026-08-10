/**
 * Postgres coverage for the multi-select aggregation.
 *
 * Exploding a JSON array is the one part of the aggregate engine written twice:
 * Postgres unpacks with `jsonb_array_elements_text` through a lateral join,
 * SQLite with the `json_each` table-valued function. The SQLite suite proves
 * the arithmetic; it cannot prove the Postgres spelling parses at all, and a
 * syntax error there surfaces as one broken dashboard panel on the only
 * dialect a production workspace is likely to run.
 *
 * Follows `analytics-pg.test.ts`: pglite's WASM bundle is environment-sensitive,
 * so a harness that fails to boot degrades to a logged skip.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;
const slug = `pg_survey_${Date.now()}`;

const post = async (path: string, body: unknown) =>
  harness!.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      "[forms-results-pg] harness setup failed — skipping pg path tests:",
      setupError.message,
    );
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-forms-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const created = await post("/api/collections", {
    slug,
    fields: [
      { name: "score", type: "integer" },
      {
        name: "channels",
        type: "json",
        options: { choices: [{ value: "search" }, { value: "friend" }, { value: "ads" }] },
      },
    ],
  });
  if (created.status !== 201) throw new Error(`collection failed: ${created.status}`);

  for (const row of [
    { score: 5, channels: ["search", "friend"] },
    { score: 3, channels: ["search"] },
    { score: 1, channels: [] },
    { score: 4 },
  ]) {
    const res = await post(`/api/items/${slug}`, row);
    if (res.status !== 201) throw new Error(`insert failed: ${res.status}`);
  }
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
}, PGLITE_BOOT_TIMEOUT_MS);

const skipped = (): boolean => {
  if (setupError || !harness) {
    expect(setupError).toBeDefined();
    return true;
  }
  return false;
};

test("pg: an array-valued json column round-trips", async () => {
  if (skipped()) return;
  // Drizzle binds a JS array as a SQL row constructor for a column whose type
  // it does not know, which is every dynamic table here — so this used to fail
  // the WRITE with "column is of type jsonb but expression is of type record"
  // on Postgres while passing on SQLite.
  const res = await harness!.fetch(`/api/items/${slug}?sort=-score`);
  expect(res.status).toBe(200);
  const rows = ((await res.json()) as { data: { score: number; channels: unknown }[] }).data;
  expect(rows[0]?.channels).toEqual(["search", "friend"]);
  expect(rows.find((r) => r.score === 1)?.channels).toEqual([]);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: count grouped by a multi-select counts each chosen value", async () => {
  if (skipped()) return;
  const res = await post(`/api/items/${slug}/aggregate`, {
    agg: "count",
    groupBy: "channels",
  });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { label: string; value: unknown }[] };
  const byLabel = new Map(data.map((r) => [r.label, Number(r.value)]));
  expect(byLabel.get("search")).toBe(2);
  expect(byLabel.get("friend")).toBe(1);
  // Rows with an empty array or no answer contribute to no bucket at all —
  // not to a null one, and not to a bucket named after the raw array.
  expect(byLabel.has("ads")).toBe(false);
  expect([...byLabel.keys()].some((k) => k.includes("["))).toBe(false);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: an avg over another column groups by each chosen value", async () => {
  if (skipped()) return;
  const res = await post(`/api/items/${slug}/aggregate`, {
    agg: "avg",
    field: "score",
    groupBy: "channels",
  });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { label: string; value: unknown }[] };
  const byLabel = new Map(data.map((r) => [r.label, Number(r.value)]));
  expect(byLabel.get("search")).toBeCloseTo(4, 5); // 5 and 3
  expect(byLabel.get("friend")).toBeCloseTo(5, 5);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: a filter still applies before the explode", async () => {
  if (skipped()) return;
  const res = await post(`/api/items/${slug}/aggregate`, {
    agg: "count",
    groupBy: "channels",
    filter: { score: { _gte: 4 } },
  });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { label: string; value: unknown }[] };
  const byLabel = new Map(data.map((r) => [r.label, Number(r.value)]));
  expect(byLabel.get("search")).toBe(1);
  expect(byLabel.get("friend")).toBe(1);
}, PGLITE_TEST_TIMEOUT_MS);
