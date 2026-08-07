/**
 * Recording a booking into a collection.
 *
 * The ledger owns the slot; the collection owns everything else about a
 * booking. What is pinned here is the half that used to be optional and is now
 * automatic, in rough order of how badly it failed before:
 *
 * - a resource records without anyone configuring anything, into a collection
 *   the platform provisions;
 * - a MOVED booking updates the record it already had, rather than leaving one
 *   sitting at the old time still reading `confirmed` — the bug the old
 *   status-only push could not avoid;
 * - a custom target with no field map is REFUSED at the point of saving,
 *   because accepting it recorded nothing and said nothing;
 * - a failed recording is written down and can be retried, rather than being
 *   indistinguishable from "recording is switched off".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { BOOKING_COLLECTION_SLUG } from "../src/server/services/booking-collection";

const BASE = "/api/admin/booking";

let h: TestHarness;
let client: Database;
let restoreLog: typeof console.log;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await h.fetch(path, json(method, body));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

/** The same derived-Monday fixture `booking.test.ts` uses, and for the same
 *  reason: a hard-coded date in a test about what is bookable is a fuse. */
const nextMonday = (): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7));
  return d;
};
const MONDAY = nextMonday();
const mondayAt = (hh: number, mm = 0): string => {
  const d = new Date(MONDAY);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
};

const makeResource = async (over: Record<string, unknown> = {}) =>
  (
    await ok("POST", `${BASE}/resources`, {
      key: "clinic",
      name: "Dr Yilmaz",
      timeZone: "UTC",
      slotMinutes: 30,
      horizonDays: 365,
      rules: [{ kind: "open", weekday: 1, startMinute: 540, endMinute: 720 }],
      ...over,
    })
  ).data as { resource: any; token: string };

const book = async (start = mondayAt(9), over: Record<string, unknown> = {}) =>
  (await ok("POST", `${BASE}/bookings`, { resource: "clinic", start, name: "Ada", ...over }))
    .data as any;

/** Rows in the provisioned collection, read straight from the physical table so
 *  the assertion does not depend on the item API's own filtering. */
const records = (): any[] => {
  const meta = client
    .query("SELECT physical_table FROM collections WHERE slug = ?")
    .get(BOOKING_COLLECTION_SLUG) as any;
  if (!meta) return [];
  return client.query(`SELECT * FROM "${meta.physical_table}" ORDER BY starts_at`).all() as any[];
};

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  restoreLog = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = restoreLog;
  client.close();
  h.cleanup();
});

describe("the collection is provisioned, not configured", () => {
  test("creating a resource creates the collection it will record into", async () => {
    const { resource } = await makeResource();
    // Not "a collection exists" — the resource has to SAY which one, or an
    // operator has no way to find it that isn't guessing.
    expect(resource.recordCollection).toBe(BOOKING_COLLECTION_SLUG);
    expect(resource.mirrorEnabled).toBe(true);
    // Null, not the slug: the resource did not choose a target, it accepted the
    // default. Storing the resolved slug would freeze today's answer into every
    // row created today.
    expect(resource.mirrorCollection).toBeNull();

    const meta = client
      .query("SELECT slug FROM collections WHERE slug = ?")
      .get(BOOKING_COLLECTION_SLUG);
    expect(meta).toBeTruthy();
  });

  test("a booking lands in it with nobody having set a field map", async () => {
    await makeResource();
    const out = await book();

    const rows = records();
    expect(rows).toHaveLength(1);
    expect(rows[0].booking_id).toBe(out.booking.id);
    expect(rows[0].customer_name).toBe("Ada");
    expect(rows[0].resource).toBe("clinic");
    expect(rows[0].status).toBe("confirmed");
    expect(rows[0].starts_at).toBe(Date.parse(mondayAt(9)));

    // And the ledger points back at it, so the admin can link the two.
    expect(out.booking.mirrorCollection).toBe(BOOKING_COLLECTION_SLUG);
    expect(out.booking.mirrorItemId).toBe(rows[0].id);
    expect(out.booking.mirrorError).toBeNull();
  });

  test("intake answers travel with the booking", async () => {
    await makeResource({
      questions: [{ name: "reason", label: "Reason", type: "text" }],
    });
    await book(mondayAt(9), { answers: { reason: "Check-up" } });

    const rows = records();
    expect(JSON.parse(rows[0].answers)).toEqual({ reason: "Check-up" });
  });

  test("a resource that predates the collection provisions it on its first booking", async () => {
    await makeResource();
    // Simulate a workspace upgraded with resources already in it: drop the
    // collection the create path provisioned and let the write path meet the
    // absence, which is exactly what an old resource does.
    const meta = client
      .query("SELECT physical_table FROM collections WHERE slug = ?")
      .get(BOOKING_COLLECTION_SLUG) as any;
    client.exec(`DROP TABLE "${meta.physical_table}"`);
    client.query("DELETE FROM collections WHERE slug = ?").run(BOOKING_COLLECTION_SLUG);
    expect(records()).toHaveLength(0);

    const out = await book();
    expect(out.booking.mirrorError).toBeNull();
    expect(records()).toHaveLength(1);
  });
});

describe("a record keeps up with the booking", () => {
  test("cancelling updates the row rather than leaving it confirmed", async () => {
    await makeResource();
    const out = await book();
    await ok("POST", `${BASE}/bookings/${out.booking.id}/cancel`, { notify: false });

    const rows = records();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("cancelled");
  });

  test("moving one carries the NEW time onto the row it already had", async () => {
    await makeResource();
    const out = await book(mondayAt(9));
    const moved = (
      await ok("POST", `${BASE}/bookings/${out.booking.id}/reschedule`, { start: mondayAt(10) })
    ).data as any;

    // A move is cancel-then-book, so there are two ledger rows and two records.
    // What matters is that the one left behind says so: the old status-only
    // push wrote `cancelled` but never the time, so a map without a status
    // column left a record sitting at 09:00 still reading confirmed.
    const rows = records();
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.booking_id === out.booking.id);
    const next = rows.find((r) => r.booking_id === moved.booking.id);
    expect(old.status).toBe("cancelled");
    expect(old.starts_at).toBe(Date.parse(mondayAt(9)));
    expect(next.status).toBe("confirmed");
    expect(next.starts_at).toBe(Date.parse(mondayAt(10)));
  });

  test("a no-show reaches the record", async () => {
    await makeResource({ leadMinutes: 0 });
    const out = await book();
    await ok("POST", `${BASE}/bookings/${out.booking.id}/no-show`);
    expect(records()[0].status).toBe("no_show");
  });

  test("confirming a hold updates the row it wrote while held", async () => {
    await makeResource();
    const out = await book(mondayAt(9), { hold: true });
    expect(records()[0].status).toBe("held");

    await ok("POST", `${BASE}/bookings/${out.booking.id}/confirm`);
    const rows = records();
    // Updated in place — a second row would double-count the appointment in
    // every report the collection feeds.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("confirmed");
  });
});

describe("a custom target is yours to map", () => {
  test("naming a collection without a field map is refused when the resource is saved", async () => {
    const res = await h.fetch(
      `${BASE}/resources`,
      json("POST", {
        key: "clinic",
        name: "Dr Yilmaz",
        timeZone: "UTC",
        mirrorCollection: "appointments",
      }),
    );
    // 422, not a resource that quietly records nothing — which is precisely
    // what the old behaviour was.
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("field map");
  });

  test("the same refusal on update", async () => {
    await makeResource();
    const res = await h.fetch(
      `${BASE}/resources/clinic`,
      json("PATCH", { mirrorCollection: "appointments" }),
    );
    expect(res.status).toBe(422);
  });

  test("clearing a custom target falls back to the provisioned default", async () => {
    await makeResource({
      mirrorCollection: "appointments",
      mirrorFieldMap: { name: "who" },
    });
    const updated = await ok("PATCH", `${BASE}/resources/clinic`, { mirrorCollection: null });
    expect(updated.data.recordCollection).toBe(BOOKING_COLLECTION_SLUG);
  });

  test("turning recording off records nowhere and says so", async () => {
    await makeResource({ mirrorEnabled: false });
    const out = await book();

    expect(records()).toHaveLength(0);
    // Not an error — nothing failed. The resource is where "off" is legible.
    expect(out.booking.mirrorError).toBeNull();
    expect(out.booking.mirrorItemId).toBeNull();

    const resource = await ok("GET", `${BASE}/resources/clinic`);
    expect(resource.data.recordCollection).toBeNull();
  });
});

describe("a failure is written down, not inferred", () => {
  test("a target that isn't ours is reported per booking and retried on request", async () => {
    await makeResource();
    // Take the slug with a collection that has none of our marker columns —
    // the workspace-already-has-a-`booking_records` case. Writing into it would
    // be writing into a stranger's business data.
    const meta = client
      .query("SELECT physical_table FROM collections WHERE slug = ?")
      .get(BOOKING_COLLECTION_SLUG) as any;
    client.exec(`DROP TABLE "${meta.physical_table}"`);
    client
      .query("UPDATE collections SET fields = ? WHERE slug = ?")
      .run(JSON.stringify([{ name: "title", type: "text" }]), BOOKING_COLLECTION_SLUG);

    const out = await book();
    // The booking still happened — the slot is the thing that must not fail.
    expect(out.booking.id).toBeTruthy();
    expect(out.booking.mirrorError).toContain("booking record target");

    // And the retry answers with the reason rather than pretending.
    const res = await h.fetch(`${BASE}/bookings/${out.booking.id}/record`, json("POST"));
    expect(res.status).toBe(422);

    // Put a real target back; the retry now succeeds and clears the error.
    client.query("DELETE FROM collections WHERE slug = ?").run(BOOKING_COLLECTION_SLUG);
    const fixed = await ok("POST", `${BASE}/bookings/${out.booking.id}/record`);
    expect(fixed.data.mirrorError).toBeNull();
    expect(fixed.data.mirrorItemId).toBeTruthy();
    expect(records()).toHaveLength(1);
  });

  test("a retry does not write a second row when one already landed", async () => {
    await makeResource();
    const out = await book();
    expect(records()).toHaveLength(1);

    await ok("POST", `${BASE}/bookings/${out.booking.id}/record`);
    expect(records()).toHaveLength(1);
  });

  test("a record is found again by booking id when the pointer was lost", async () => {
    await makeResource();
    const out = await book();
    const before = records()[0].id;

    // The first attempt landing the row but failing before the pointer was
    // stored is a real ordering: two writes, and only one of them can be first.
    client.query("UPDATE bookings SET mirror_item_id = NULL WHERE id = ?").run(out.booking.id);

    const again = await ok("POST", `${BASE}/bookings/${out.booking.id}/record`);
    expect(records()).toHaveLength(1);
    expect(again.data.mirrorItemId).toBe(before);
  });
});
