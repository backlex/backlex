/**
 * Postgres coverage for CDC sinks.
 *
 * The changefeed's cursor is a `(updated_at, id)` keyset, and `updated_at` is a
 * timestamptz here and an epoch-ms integer on the SQLite twin. A sink is the
 * one caller that PERSISTS that cursor and hands it back later, so a dialect
 * mismatch would not fail loudly — it would resume from the wrong place, which
 * is the class that shipped a broken timestamp filter here once already.
 *
 * Follows `auth-hooks-pg.test.ts`: pglite's WASM bundle is environment-
 * sensitive, so a harness that fails to boot degrades to a logged skip.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let harness: PgTestHarness | undefined;
let sinkId = "";

const JSON_HEADERS = { "Content-Type": "application/json" };
const BASE = "/api/admin/cdc-sinks";
const realFetch = globalThis.fetch;

let deliveries: Array<{ records: Array<{ op: string; key: string; data: any }> }> = [];

const post = (path: string, body?: unknown, method = "POST") =>
  harness!.fetch(path, {
    method,
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  globalThis.fetch = (async (url: any, init: any) => {
    if (!String(url).startsWith("https://pgsink.test/")) return realFetch(url, init);
    deliveries.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("ok");
  }) as typeof fetch;
  harness = (await makeHarnessPgOrFail("cdc-pg")) ?? undefined;
  if (!harness) return;
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-cdc-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const made = await post("/api/collections", {
    name: "Orders",
    slug: "orders",
    softDelete: true,
    fields: [{ name: "title", type: "text" }],
  });
  if (!made.ok) throw new Error(`collection failed: ${made.status} ${await made.text()}`);

  const sink = await post(BASE, {
    name: "pg-warehouse",
    collection: "orders",
    destination: "webhook",
    config: { url: "https://pgsink.test/ingest" },
  });
  if (!sink.ok) throw new Error(`sink failed: ${sink.status} ${await sink.text()}`);
  sinkId = ((await sink.json()) as { data: { id: string } }).data.id;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness?.cleanup();
});

test("a persisted timestamptz cursor resumes from the right place", async () => {
  if (!harness) return;
  await post("/api/items/orders", { title: "first" });
  deliveries = [];

  const first = (await (await post(`${BASE}/${sinkId}/run`)).json()) as { delivered: number };
  expect(first.delivered).toBe(1);
  expect(deliveries[0]!.records[0]!.data.title).toBe("first");

  // The cursor is now a timestamptz-derived value written into a text column
  // and handed straight back to the changefeed's keyset comparison. If the two
  // dialects disagreed about the encoding this would silently re-send the row
  // — or skip the next one — rather than erroring.
  deliveries = [];
  const idle = (await (await post(`${BASE}/${sinkId}/run`)).json()) as { delivered: number };
  expect(idle.delivered).toBe(0);
  expect(deliveries.length).toBe(0);

  await post("/api/items/orders", { title: "second" });
  const next = (await (await post(`${BASE}/${sinkId}/run`)).json()) as { delivered: number };
  expect(next.delivered).toBe(1);
  expect(deliveries[0]!.records[0]!.data.title).toBe("second");
}, PGLITE_TEST_TIMEOUT_MS);

test("the changefeed's own cursor is decodable on Postgres", async () => {
  if (!harness) return;
  // The bug this pins, found by the sink and not by any client test: on
  // Postgres `updated_at` arrives as `2026-08-10 00:45:25.406+00`, which is not
  // ISO 8601, so `Number()` gave NaN and every page emitted the cursor
  // `NaN.<id>`. A client stored it, sent it back, and its next sync was refused
  // as invalid — permanently, because there was nothing else to send.
  const page = (await (await harness.fetch("/api/items/orders/changes")).json()) as {
    cursor: string | null;
  };
  expect(page.cursor).toBeTruthy();
  const decoded = Buffer.from(page.cursor!, "base64url").toString("utf8");
  expect(decoded).not.toContain("NaN");
  expect(Number(decoded.split(".")[0])).toBeGreaterThan(0);

  // …and it round-trips: sending it back returns nothing new rather than 422.
  const again = await harness.fetch(
    `/api/items/orders/changes?since=${encodeURIComponent(page.cursor!)}`,
  );
  expect(again.status).toBe(200);
  expect(((await again.json()) as { data: unknown[] }).data.length).toBe(0);
}, PGLITE_TEST_TIMEOUT_MS);

test("a delete crosses the dialect as a delete", async () => {
  if (!harness) return;
  const created = (await (
    await post("/api/items/orders", { title: "doomed" })
  ).json()) as { data: { id: string } };
  await post(`${BASE}/${sinkId}/run`);
  deliveries = [];

  await harness.fetch(`/api/items/orders/${created.data.id}`, { method: "DELETE" });
  await post(`${BASE}/${sinkId}/run`);
  expect(deliveries[0]!.records[0]!.op).toBe("delete");
}, PGLITE_TEST_TIMEOUT_MS);

test("the sink row round-trips its booleans and counters on Postgres", async () => {
  if (!harness) return;
  const rows = await harness.exec(
    `SELECT enabled, batch_size, consecutive_failures, cursor FROM cdc_sinks WHERE id = '${sinkId}'`,
  );
  expect(rows[0]!.enabled).toBe(true);
  expect(rows[0]!.batch_size).toBe(100);
  expect(rows[0]!.consecutive_failures).toBe(0);
  expect(rows[0]!.cursor).not.toBeNull();
}, PGLITE_TEST_TIMEOUT_MS);
