/**
 * Postgres coverage for recording a booking into a collection.
 *
 * Three things here are written per dialect and therefore cannot be proved by
 * the SQLite suite:
 *
 * - the collection is CREATED by `applyCollection` from our field list, so the
 *   `booking_id` column arrives as `text NOT NULL UNIQUE` in the Postgres
 *   spelling — a DDL that does not parse takes the whole feature with it, and
 *   the SQLite suite would never see it;
 * - `starts_at` is a timestamp, which the write path serializes as a `Date` on
 *   Postgres and a number on SQLite. The wrong one is a rejected row on the
 *   only dialect a production workspace is likely to run;
 * - the recovery lookup compares a text column inside a hand-built `sql`
 *   fragment against a bound parameter, which is the shape that has bitten this
 *   repo before.
 *
 * Follows `form-drafts-pg.test.ts`: pglite's WASM bundle is
 * environment-sensitive, so a harness that fails to boot degrades to a logged
 * skip rather than a red gate that says nothing about this code.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";
import { BOOKING_COLLECTION_SLUG } from "../src/server/services/booking-collection";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;

const BASE = "/api/admin/booking";

/** A Monday comfortably in the future, derived rather than written down. */
const MONDAY = (() => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7));
  return d;
})();
const mondayAt = (hh: number): string => {
  const d = new Date(MONDAY);
  d.setUTCHours(hh, 0, 0, 0);
  return d.toISOString();
};

const post = async (path: string, body?: unknown) =>
  harness!.fetch(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });

const ok = async (path: string, body?: unknown) => {
  const res = await post(path, body);
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

/** Rows in the provisioned collection, read through the item API — the physical
 *  table name is derived per workspace and the API is what a reader would use. */
const records = async (): Promise<any[]> => {
  const res = await harness!.fetch(
    `/api/items/${BOOKING_COLLECTION_SLUG}?limit=100&sort=starts_at`,
  );
  if (!res.ok) return [];
  return ((await res.json()) as { data: any[] }).data;
};

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      "[booking-mirror-pg] harness setup failed — skipping pg path tests:",
      setupError.message,
    );
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-booking-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const resource = await post(`${BASE}/resources`, {
    key: "clinic",
    name: "Dr Yilmaz",
    timeZone: "UTC",
    slotMinutes: 30,
    horizonDays: 365,
    rules: [{ kind: "open", weekday: 1, startMinute: 540, endMinute: 720 }],
  });
  if (!resource.ok) throw new Error(`resource failed: ${resource.status}`);
}, 60_000);

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

test("pg: the collection is provisioned and a booking lands in it", async () => {
  if (skipped()) return;
  const out = (await ok(`${BASE}/bookings`, {
    resource: "clinic",
    start: mondayAt(9),
    name: "Ada",
  })) as any;

  // A DDL that did not parse would have left `mirrorError` set and no rows.
  expect(out.data.booking.mirrorError).toBeNull();
  expect(out.data.booking.mirrorCollection).toBe(BOOKING_COLLECTION_SLUG);

  const rows = await records();
  expect(rows).toHaveLength(1);
  expect(rows[0].booking_id).toBe(out.data.booking.id);
  expect(rows[0].customer_name).toBe("Ada");
  // The timestamp round-trips. A number written into a `timestamptz` is the
  // failure this assertion exists for.
  expect(new Date(rows[0].starts_at as string).toISOString()).toBe(mondayAt(9));
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: cancelling updates the row in place", async () => {
  if (skipped()) return;
  const out = (await ok(`${BASE}/bookings`, {
    resource: "clinic",
    start: mondayAt(10),
    name: "Grace",
  })) as any;
  await ok(`${BASE}/bookings/${out.data.booking.id}/cancel`, { notify: false });

  const rows = await records();
  const row = rows.find((r) => r.booking_id === out.data.booking.id);
  expect(row.status).toBe("cancelled");
  // Updated, not appended — one booking is one record.
  expect(rows.filter((r) => r.booking_id === out.data.booking.id)).toHaveLength(1);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: a lost pointer is recovered by looking the booking id up", async () => {
  if (skipped()) return;
  const out = (await ok(`${BASE}/bookings`, {
    resource: "clinic",
    start: mondayAt(11),
    name: "Alan",
  })) as any;
  const before = out.data.booking.mirrorItemId as string;
  expect(before).toBeTruthy();

  // Drop the pointer the way a first attempt that landed the row but failed
  // before storing it would.
  const { buildContext } = await import("../src/server/context");
  const { sql } = await import("drizzle-orm");
  const ctx = (await buildContext(harness!.env)) as any;
  await ctx.db.execute(
    sql`UPDATE bookings SET mirror_item_id = NULL WHERE id = ${out.data.booking.id}`,
  );

  const again = await ok(`${BASE}/bookings/${out.data.booking.id}/record`);
  // The text comparison inside the hand-built fragment found it rather than
  // writing a duplicate.
  expect(again.data.mirrorItemId).toBe(before);
  const rows = await records();
  expect(rows.filter((r) => r.booking_id === out.data.booking.id)).toHaveLength(1);
}, PGLITE_TEST_TIMEOUT_MS);
