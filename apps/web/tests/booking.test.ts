/**
 * Availability and booking, end to end through the HTTP surface.
 *
 * The slot arithmetic is proved separately and without a database in
 * `booking-slots.test.ts`. What is pinned here is everything that only exists
 * once there IS a database and a clock, in rough order of how much it costs to
 * get wrong:
 *
 * - two people taking one slot produce ONE booking and one refusal — the guard
 *   is insert-then-verify, so this is the property the whole design turns on;
 * - the public path may only take what the grid published, while an operator
 *   taking a call may not be restricted to it;
 * - a hold occupies the slot and then stops occupying it because the clock
 *   passed, without anything having run;
 * - the manage token is the whole grant, so it has to be the only way in and a
 *   reschedule has to spend the old one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { getTableColumns } from "drizzle-orm";
import * as sqliteSchema from "@backlex/db/sqlite/schema";
import {
  RULES_PER_INSERT,
  SQLITE_MAX_VARIABLES,
  createBooking,
  effectiveBookingStatus,
  isUniqueViolation,
  listSlots,
  loadResource,
  stillOccupies,
  type BookingRow,
} from "../src/server/services/booking";

const BASE = "/api/admin/booking";
const PUBLIC = "/api/public/book";

let h: TestHarness;
let client: Database;
let emails: string[];
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

/**
 * The resource under test opens 09:00–12:00 UTC on Mondays, so every fixture
 * below is anchored to a Monday.
 *
 * That Monday is DERIVED, not written down. It used to be the literal
 * 2026-08-03, and the public slot grid — correctly — hides slots that have
 * already started. The suite therefore passed until the wall clock reached that
 * Monday, and then lost one slot every half hour through the morning: `expected
 * 6, received 2` at 10:15 UTC, green again the next day. A hard-coded date in a
 * test whose subject is "what is still bookable" is a fuse, not a fixture.
 *
 * `MONDAY` is the first Monday at least a week out, so the whole window is
 * always comfortably in the future no matter when the suite runs.
 */
const nextMonday = (): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7);
  // 1 = Monday. Walk forward to the next one (0 days if it already is).
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7));
  return d;
};
const MONDAY = nextMonday();
/** That Monday at `hh:mm` UTC, as the ISO string the API speaks. */
const mondayAt = (hh: number, mm = 0): string => {
  const d = new Date(MONDAY);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
};
/** Midnight UTC `offset` days from that Monday (negative = before). */
const dayFromMonday = (offset: number): string => {
  const d = new Date(MONDAY);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString();
};
const MONDAY_0900 = mondayAt(9);
const SUNDAY = dayFromMonday(-1);
const TUESDAY = dayFromMonday(1);
/** A fixed "now" for the unit-level slot calls — two days before the window,
 *  so it is in the past relative to the fixtures and stable across runs. */
const BEFORE = Date.parse(dayFromMonday(-2));

const makeResource = async (over: Record<string, unknown> = {}) => {
  const body = {
    key: "clinic",
    name: "Dr Yilmaz",
    timeZone: "UTC",
    slotMinutes: 30,
    horizonDays: 365,
    rules: [{ kind: "open", weekday: 1, startMinute: 540, endMinute: 720 }],
    ...over,
  };
  const out = await ok("POST", `${BASE}/resources`, body);
  return out.data as { resource: any; token: string; url: string };
};

const ctxOf = async () => {
  const { buildContext } = await import("../src/server/context");
  return (await buildContext(h.env)) as any;
};

/**
 * The workspace the harness signed the admin into.
 *
 * The tests that go straight at the service — the concurrency ones, which the
 * HTTP layer would serialise and so prove nothing about — have to scope
 * themselves the same way the route does, and the route takes it off the
 * session rather than assuming the null workspace.
 */
const tenantId = (): string | null => {
  const row = client.query("SELECT tenant_id FROM booking_resources LIMIT 1").get() as any;
  return row?.tenant_id ?? null;
};

/** The stored resource row, scoped like the route scopes it. */
const resourceRow = async (key: string) => {
  const ctx = await ctxOf();
  const row = await loadResource(ctx, tenantId(), key);
  if (!row) throw new Error(`resource ${key} not found`);
  return { ctx, resource: row };
};

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  emails = [];
  restoreLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[email]")) emails.push(line);
  };
});

afterEach(() => {
  console.log = restoreLog;
  client.close();
  h.cleanup();
});

describe("resources", () => {
  test("creating one returns the page token exactly once", async () => {
    const created = await makeResource();
    expect(created.token).toMatch(/^bkg_[0-9a-f]{48}$/);
    expect(created.url).toContain(`/book/${created.token}`);

    // Nothing reproduces it afterwards — only the hash is stored.
    const fetched = await ok("GET", `${BASE}/resources/clinic`);
    expect(JSON.stringify(fetched)).not.toContain(created.token);
  });

  test("the key has to be unique in a workspace", async () => {
    await makeResource();
    const res = await h.fetch(`${BASE}/resources`, json("POST", { key: "clinic", name: "Another" }));
    expect(res.status).toBe(409);
  });

  test("a rule crossing midnight is refused with the shape that replaces it", async () => {
    const res = await h.fetch(
      `${BASE}/resources`,
      json("POST", {
        key: "bar",
        name: "Late bar",
        rules: [{ kind: "open", weekday: 5, startMinute: 1320, endMinute: 1560 }],
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("two rules");
  });

  test("a rule with no weekday and no dates is refused", async () => {
    // It would apply to every day forever, which as a block reads like the
    // booking system is broken rather than like a configuration choice.
    const res = await h.fetch(
      `${BASE}/resources`,
      json("POST", {
        key: "x",
        name: "X",
        rules: [{ kind: "block", startMinute: 0, endMinute: 1440 }],
      }),
    );
    expect(res.status).toBe(422);
  });

  test("an unknown time zone is refused rather than silently treated as UTC", async () => {
    const res = await h.fetch(
      `${BASE}/resources`,
      json("POST", { key: "y", name: "Y", timeZone: "Mars/Olympus" }),
    );
    expect(res.status).toBe(422);
  });

  test("patching rules replaces the whole set", async () => {
    await makeResource();
    const out = await ok("PATCH", `${BASE}/resources/clinic`, {
      rules: [{ kind: "open", weekday: 2, startMinute: 600, endMinute: 660 }],
    });
    expect(out.data.rules).toHaveLength(1);
    expect(out.data.rules[0].weekday).toBe(2);
  });

  /**
   * A week of openings with a lunch break is fourteen rules, and every rule
   * binds eleven parameters. D1's SQLite stops at 100 of them, so a single
   * INSERT broke at the tenth rule — and since the replace deletes first, the
   * failure did not leave the old hours in place, it left the resource with
   * NONE: a calendar that answered 500 and then quietly stopped taking
   * bookings.
   *
   * This test pins the round trip — fourteen rules go in and fourteen come
   * back out of a fresh read — but it CANNOT reproduce the refusal, because
   * bun:sqlite is compiled with a variable ceiling in the tens of thousands
   * and would happily bind all 154. The ceiling itself is guarded by the
   * budget test below, which is the one that fails if a column is added.
   */
  test("a resource takes more rules than one INSERT can bind", async () => {
    await makeResource();
    const rules = [
      ...[1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
        kind: "open" as const,
        weekday,
        startMinute: 540,
        endMinute: 1020,
      })),
      ...[1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
        kind: "block" as const,
        weekday,
        startMinute: 720,
        endMinute: 780,
      })),
    ];
    const out = await ok("PATCH", `${BASE}/resources/clinic`, { rules });
    expect(out.data.rules).toHaveLength(14);

    // And the read path agrees — the rows are really there, not just echoed
    // back out of the request that wrote them.
    const read = await ok("GET", `${BASE}/resources/clinic`);
    expect(read.data.rules).toHaveLength(14);
    expect(read.data.rules.filter((r: { kind: string }) => r.kind === "block")).toHaveLength(7);
  });

  /**
   * The guard the local driver cannot give us.
   *
   * A multi-row INSERT binds one parameter per column per row, so the batch
   * size and the row's width multiply. Reading the width off the schema rather
   * than writing 11 here is the whole point: adding a column to `booking_rules`
   * is what silently re-breaks this, and it should fail in the suite rather
   * than on D1 the first time somebody saves a full week.
   */
  test("a batched rule insert stays inside SQLite's variable budget", () => {
    const columns = Object.keys(getTableColumns(sqliteSchema.bookingRules)).length;
    expect(RULES_PER_INSERT * columns).toBeLessThanOrEqual(SQLITE_MAX_VARIABLES);
  });

  test("rotating the token invalidates the old page link", async () => {
    const created = await makeResource();
    const rotated = await ok("POST", `${BASE}/resources/clinic/rotate-token`);
    expect(rotated.data.token).not.toBe(created.token);

    const oldLink = await h.fetch(`${PUBLIC}/${created.token}/slots`);
    expect(oldLink.status).toBe(404);
    const newLink = await h.fetch(`${PUBLIC}/${rotated.data.token}/slots`);
    expect(newLink.status).toBe(200);
  });

  test("deleting refuses while upcoming bookings reference it", async () => {
    const created = await makeResource();
    await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      name: "Ada",
      email: "ada@example.com",
    });
    const refused = await h.fetch(`${BASE}/resources/clinic`, json("DELETE"));
    expect(refused.status).toBe(409);
    const forced = await h.fetch(`${BASE}/resources/clinic?force=true`, json("DELETE"));
    expect(forced.status).toBe(200);
  });
});

describe("the public grid", () => {
  test("a paused resource and an unknown token refuse identically", async () => {
    const created = await makeResource();
    await ok("PATCH", `${BASE}/resources/clinic`, { active: false });

    const paused = await h.fetch(`${PUBLIC}/${created.token}/slots`);
    const unknown = await h.fetch(`${PUBLIC}/bkg_${"0".repeat(48)}/slots`);
    expect(paused.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Same code and same sentence, so the endpoint is not an oracle for which
    // tokens ever existed. (`requestId` differs per request by design.)
    expect((await paused.json()).error).toEqual((await unknown.json()).error);
  });

  test("slots come back for the published hours only", async () => {
    const created = await makeResource();
    const out = await ok(
      "GET",
      `${PUBLIC}/${created.token}/slots?from=${SUNDAY}&to=${TUESDAY}`,
    );
    expect(out.data.slots).toHaveLength(6); // 09:00–12:00 in half hours
    expect(out.data.slots[0].start).toBe(MONDAY_0900);
    expect(out.data.resource.name).toBe("Dr Yilmaz");
    // The booker's view of a resource carries no notify list and no mirror.
    expect(JSON.stringify(out.data.resource)).not.toContain("mirror");
  });

  test("a booked slot leaves the grid", async () => {
    const created = await makeResource();
    await ok("POST", `${PUBLIC}/${created.token}`, { start: MONDAY_0900, email: "a@example.com" });
    const out = await ok(
      "GET",
      `${PUBLIC}/${created.token}/slots?from=${SUNDAY}&to=${TUESDAY}`,
    );
    expect(out.data.slots.map((s: any) => s.start)).not.toContain(MONDAY_0900);
    expect(out.data.slots).toHaveLength(5);
  });

  test("capacity counts down instead of closing the slot", async () => {
    const created = await makeResource({ key: "class", capacity: 3 });
    await ok("POST", `${PUBLIC}/${created.token}`, { start: MONDAY_0900, email: "a@example.com" });
    const out = await ok("GET", `${PUBLIC}/${created.token}/slots?from=${SUNDAY}`);
    expect(out.data.slots[0].remaining).toBe(2);
  });
});

describe("taking a slot", () => {
  test("the booker gets a manage link and a confirmation", async () => {
    const created = await makeResource();
    const out = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      name: "Ada",
      email: "ada@example.com",
    });
    expect(out.data.booking.status).toBe("confirmed");
    expect(out.data.manageUrl).toMatch(/\/b\/bkm_[0-9a-f]{48}$/);
    expect(out.data.emailed).toBe(true);
    expect(emails.join("\n")).toContain("ada@example.com");
  });

  test("the public path refuses a time that is not on the grid", async () => {
    const created = await makeResource();
    const offGrid = await h.fetch(
      `${PUBLIC}/${created.token}`,
      json("POST", { start: mondayAt(9, 7), email: "a@example.com" }),
    );
    expect(offGrid.status).toBe(422);

    const closed = await h.fetch(
      `${PUBLIC}/${created.token}`,
      json("POST", { start: mondayAt(15), email: "a@example.com" }),
    );
    expect(closed.status).toBe(422);
  });

  test("an operator is NOT restricted to the grid", async () => {
    // The phone call is exactly the case the published grid cannot describe.
    await makeResource();
    const out = await ok("POST", `${BASE}/bookings`, {
      resource: "clinic",
      start: mondayAt(15, 7),
      end: mondayAt(15, 37),
      name: "Walk-in",
    });
    expect(out.data.booking.status).toBe("confirmed");
    expect(out.data.booking.source).toBe("admin");
  });

  test("a required question has to be answered, and unknown answers are dropped", async () => {
    const created = await makeResource({
      key: "q",
      questions: [
        { name: "reason", label: "Reason for visit", required: true },
        { name: "insurer", label: "Insurer", type: "select", options: ["A", "B"] },
      ],
    });

    const missing = await h.fetch(
      `${PUBLIC}/${created.token}`,
      json("POST", { start: MONDAY_0900, email: "a@example.com" }),
    );
    expect(missing.status).toBe(422);

    const badOption = await h.fetch(
      `${PUBLIC}/${created.token}`,
      json("POST", {
        start: MONDAY_0900,
        email: "a@example.com",
        answers: { reason: "checkup", insurer: "Z" },
      }),
    );
    expect(badOption.status).toBe(422);

    const out = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      email: "a@example.com",
      answers: { reason: "checkup", smuggled: "value" },
    });
    // A public form must not be able to grow the stored shape on its own.
    expect(out.data.booking.answers).toEqual({ reason: "checkup" });
  });

  /**
   * `required` is the PUBLIC page's contract, not the resource's. An operator
   * writing down a booking taken over the telephone may not have asked yet,
   * and refusing it would lose the appointment rather than gain the answer —
   * the same asymmetry that lets the operator book off the published grid.
   */
  test("a required question binds the public page, not the operator", async () => {
    await makeResource({
      key: "q2",
      questions: [{ name: "reason", label: "Reason for visit", required: true }],
    });

    const out = await ok("POST", `${BASE}/bookings`, {
      resource: "q2",
      start: mondayAt(15, 7),
      name: "Walk-in",
    });
    expect(out.data.booking.status).toBe("confirmed");
    expect(out.data.booking.answers).toEqual({});

    // What the operator DID hear still travels, and is still validated.
    const answered = await ok("POST", `${BASE}/bookings`, {
      resource: "q2",
      start: mondayAt(15, 37),
      answers: { reason: "checkup" },
    });
    expect(answered.data.booking.answers).toEqual({ reason: "checkup" });
  });

  test("a yes/no keeps its type, on both paths", async () => {
    const created = await makeResource({
      key: "q3",
      questions: [{ name: "insured", label: "Insured", type: "boolean" }],
    });

    const pub = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      email: "a@example.com",
      answers: { insured: false },
    });
    // `false` is an answer, not an absence — storing it as the string "false"
    // would make a mirrored boolean column refuse it.
    expect(pub.data.booking.answers).toEqual({ insured: false });

    const admin = await ok("POST", `${BASE}/bookings`, {
      resource: "q3",
      start: mondayAt(15, 7),
      answers: { insured: true },
    });
    expect(admin.data.booking.answers).toEqual({ insured: true });
  });
});

/**
 * The page belongs on the operator's site, so it takes their colours. What is
 * pinned here is the boundary rather than the palette: an accent reaches a
 * style declaration on a page nobody is authenticated on, so anything that is
 * not a plain hex colour must not survive the write.
 */
describe("the public page's appearance", () => {
  test("only the renderable keys are stored, and the page is handed them", async () => {
    const created = await makeResource({
      key: "look",
      settings: { theme: "light", accent: "#34C79A", font: "lexend" },
    });
    expect(created.resource.settings).toEqual({
      theme: "light",
      accent: "#34C79A",
      font: "lexend",
    });

    const res = await h.fetch(`${PUBLIC}/${created.token}/slots`);
    const pub = (await res.json()) as any;
    expect(pub.data.resource.settings).toEqual({
      theme: "light",
      accent: "#34C79A",
      font: "lexend",
    });
  });

  test("an accent that is not a colour is dropped rather than stored", async () => {
    // The page pastes this into a style declaration. A value the reader would
    // have to be trusted to reject is a value the writer should never keep.
    const res = await h.fetch(
      `${BASE}/resources`,
      json("POST", {
        key: "bad",
        name: "Bad",
        timeZone: "UTC",
        settings: { accent: "red; background:url(javascript:alert(1))" },
      }),
    );
    expect(res.status).toBe(422);

    // A well-formed body with an unknown key keeps only what can be rendered.
    const ok2 = await ok("POST", `${BASE}/resources`, {
      key: "partial",
      name: "Partial",
      timeZone: "UTC",
      settings: { theme: "light", logo: "https://evil.example/x.png" },
    });
    expect(ok2.data.resource.settings).toEqual({ theme: "light" });
  });

  test("no appearance means the visitor's own light/dark, and stays that way", async () => {
    const created = await makeResource({ key: "plain" });
    expect(created.resource.settings).toBeNull();

    // A patch that says nothing about appearance leaves it alone; `null` is
    // how "back to the defaults" is said.
    const painted = await ok("PATCH", `${BASE}/resources/plain`, {
      settings: { theme: "dark" },
    });
    expect(painted.data.settings).toEqual({ theme: "dark" });
    const renamed = await ok("PATCH", `${BASE}/resources/plain`, { name: "Still dark" });
    expect(renamed.data.settings).toEqual({ theme: "dark" });
    const cleared = await ok("PATCH", `${BASE}/resources/plain`, { settings: null });
    expect(cleared.data.settings).toBeNull();
  });

  /**
   * The pages are meant to sit in an iframe on the operator's own site. On
   * Cloudflare that is only reachable from the Worker's own header middleware —
   * `_headers` can only ADD to a policy and the browser takes the stricter of
   * two — so what is pinned here is that the framable policy is the one these
   * paths actually get, X-Frame-Options included.
   */
  test("the booking pages are framable, and the admin's are not", async () => {
    for (const path of ["/book/bkg_whatever", "/b/bkm_whatever", "/api/public/book/x/slots"]) {
      const res = await h.fetch(path);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors *");
      // XFO has no allow-all value, so its mere presence would block the frame.
      expect(res.headers.get("x-frame-options")).toBeNull();
    }

    const admin = await h.fetch("/api/admin/booking/resources");
    expect(admin.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });

  test("a filled honeypot writes nothing and says nothing about it", async () => {
    const created = await makeResource({ key: "bots" });

    const out = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      email: "bot@example.com",
      website: "https://spam.example",
    });
    // Indistinguishable from the real thing at a glance — a 201 carrying a
    // booking-shaped receipt — so a script cannot tell which submissions land.
    expect(out.data.booking.status).toBe("confirmed");

    // But nothing was written, and the slot it aimed at is still on offer.
    const listed = await ok("GET", `${BASE}/bookings?resource=bots`);
    expect(listed.total).toBe(0);
    const slots = await ok("GET", `${PUBLIC}/${created.token}/slots`);
    expect(slots.data.slots.some((s: any) => s.start === MONDAY_0900)).toBe(true);
  });

  test("the manage page is painted like the calendar it was booked on", async () => {
    const created = await makeResource({ key: "same", settings: { theme: "light" } });
    const made = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      email: "a@example.com",
    });
    const manageToken = String(made.data.manageUrl).split("/b/")[1];
    const view = await ok("GET", `${PUBLIC}/manage/${manageToken}`);
    expect(view.data.resource.settings).toEqual({ theme: "light" });
  });
});

describe("the overlap guard", () => {
  test("two racers for one slot produce one booking and one refusal", async () => {
    await makeResource();
    const { ctx, resource } = await resourceRow("clinic");
    const tid = tenantId();
    const start = Date.parse(MONDAY_0900);
    const now = BEFORE;

    // Straight at the service, both in flight at once — the HTTP layer would
    // serialise them and prove nothing.
    const results = await Promise.allSettled([
      createBooking(ctx, tid, resource, { start, email: "a@example.com" }, { source: "public" }, now),
      createBooking(ctx, tid, resource, { start, email: "b@example.com" }, { source: "public" }, now),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason.code).toBe("CONFLICT");

    // And the loser withdrew its own row rather than leaving it behind.
    const list = await ok("GET", `${BASE}/bookings`);
    expect(list.total).toBe(1);
  });

  test("a capacity-3 resource takes three racers and refuses the fourth", async () => {
    await makeResource({ key: "class", capacity: 3 });
    const { ctx, resource } = await resourceRow("class");
    const tid = tenantId();
    const start = Date.parse(MONDAY_0900);
    const now = BEFORE;

    const results = await Promise.allSettled(
      ["a", "b", "c", "d"].map((who) =>
        createBooking(
          ctx,
          tid,
          resource,
          { start, email: `${who}@example.com` },
          { source: "public" },
          now,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  test("buffers keep an adjacent slot from being taken", async () => {
    const created = await makeResource({
      key: "buffered",
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
    });
    await ok("POST", `${PUBLIC}/${created.token}`, { start: MONDAY_0900, email: "a@example.com" });

    // 09:30 is on the grid but inside the buffers around 09:00–09:30.
    const adjacent = await h.fetch(
      `${PUBLIC}/${created.token}`,
      json("POST", { start: mondayAt(9, 30), email: "b@example.com" }),
    );
    expect(adjacent.status).toBe(409);

    const out = await ok("GET", `${PUBLIC}/${created.token}/slots?from=${SUNDAY}`);
    expect(out.data.slots.map((s: any) => s.start)).not.toContain(mondayAt(9, 30));
  });
});

describe("holds", () => {
  test("a hold occupies the slot and then lapses by the clock alone", async () => {
    await makeResource({ key: "held", holdMinutes: 10 });
    const { ctx, resource } = await resourceRow("held");
    const start = Date.parse(MONDAY_0900);
    const now = BEFORE;

    const held = await createBooking(
      ctx,
      tenantId(),
      resource,
      { start, email: "a@example.com", hold: true },
      { source: "public" },
      now,
    );
    expect(held.booking.status).toBe("held");
    // No confirmation mail goes out for something that is not yet a booking.
    expect(held.emailed).toBe(false);

    // While the hold lives, the slot is gone.
    const during = await listSlots(ctx, resource, { from: Date.parse(SUNDAY) }, now + 60_000);
    expect(during.slots.map((s) => s.start)).not.toContain(MONDAY_0900);

    // Eleven minutes later nothing has run, and the slot is back.
    const after = await listSlots(ctx, resource, { from: Date.parse(SUNDAY) }, now + 11 * 60_000);
    expect(after.slots.map((s) => s.start)).toContain(MONDAY_0900);
  });

  test("a lapsed hold gives its seat back to the next writer", async () => {
    // The seat index reads a COLUMN, and a lapsed hold's column still says
    // `held`. Somebody has to say so out loud, and it is the writer who wants
    // the seat — not a cron. This is the test that pins that.
    await makeResource({ key: "held", holdMinutes: 10 });
    const { ctx, resource } = await resourceRow("held");
    const tid = tenantId();
    const start = Date.parse(MONDAY_0900);
    const now = BEFORE;

    const held = await createBooking(
      ctx,
      tid,
      resource,
      { start, email: "a@example.com", hold: true },
      { source: "public" },
      now,
    );

    // While it lives, the seat is unavailable.
    await expect(
      createBooking(ctx, tid, resource, { start, email: "b@example.com" }, { source: "public" }, now + 60_000),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Once it lapses the seat is free, and the lapsed row has been told so.
    const later = await createBooking(
      ctx,
      tid,
      resource,
      { start, email: "b@example.com" },
      { source: "public" },
      now + 11 * 60_000,
    );
    expect(later.booking.status).toBe("confirmed");

    const lapsed = await ok("GET", `${BASE}/bookings/${held.booking.id}`);
    expect(lapsed.data.storedStatus).toBe("expired");
  });

  test("confirming a lapsed hold is refused", async () => {
    await makeResource({ key: "held", holdMinutes: 1 });
    const { ctx, resource } = await resourceRow("held");
    const tid = tenantId();
    const now = BEFORE;
    const held = await createBooking(
      ctx,
      tid,
      resource,
      { start: Date.parse(MONDAY_0900), email: "a@example.com", hold: true },
      { source: "public" },
      now,
    );

    const { confirmBooking } = await import("../src/server/services/booking");
    await expect(
      confirmBooking(ctx, tid, held.booking.id, now + 2 * 60_000),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("stillOccupies is the single place the question is answered", () => {
    const row = { status: "held", holdExpiresAt: 1000 } as Pick<BookingRow, "status" | "holdExpiresAt">;
    expect(stillOccupies(row, 999)).toBe(true);
    expect(stillOccupies(row, 1001)).toBe(false);
    expect(stillOccupies({ status: "confirmed", holdExpiresAt: null }, 1e12)).toBe(true);
    expect(stillOccupies({ status: "cancelled", holdExpiresAt: null }, 0)).toBe(false);
  });
});

describe("derived status", () => {
  test("completed and expired are never written", () => {
    const base = { startAt: 0, endAt: 1000, holdExpiresAt: null } as BookingRow;
    expect(effectiveBookingStatus({ ...base, status: "confirmed" }, 500)).toBe("confirmed");
    expect(effectiveBookingStatus({ ...base, status: "confirmed" }, 2000)).toBe("completed");
    expect(
      effectiveBookingStatus({ ...base, status: "held", holdExpiresAt: 900 }, 2000),
    ).toBe("expired");
    // A cancellation is a decision somebody made; the clock cannot undo it.
    expect(effectiveBookingStatus({ ...base, status: "cancelled" }, 2000)).toBe("cancelled");
  });

  test("filtering by a derived status matches rows nothing has swept", async () => {
    await makeResource();
    await ok("POST", `${BASE}/bookings`, {
      resource: "clinic",
      start: "2020-01-06T09:00:00.000Z",
      end: "2020-01-06T09:30:00.000Z",
      name: "Long ago",
    });
    const done = await ok("GET", `${BASE}/bookings?status=completed`);
    expect(done.total).toBe(1);
    const upcoming = await ok("GET", `${BASE}/bookings?status=confirmed`);
    expect(upcoming.total).toBe(0);
  });
});

describe("listing order", () => {
  /** An operator's list is read "who is coming next"; an audit is read "what
   *  came in last". Both are one page deep, so the order has to be decided in
   *  SQL rather than after slicing. */
  test("asc is nearest-first and desc stays the default", async () => {
    await makeResource();
    for (const start of ["2035-01-01T09:00:00.000Z", "2035-01-08T09:00:00.000Z"]) {
      await ok("POST", `${BASE}/bookings`, { resource: "clinic", start, name: start });
    }

    const asc = await ok("GET", `${BASE}/bookings?order=asc`);
    expect(asc.data.map((b: { start: string }) => b.start)).toEqual([
      "2035-01-01T09:00:00.000Z",
      "2035-01-08T09:00:00.000Z",
    ]);

    const fallback = await ok("GET", `${BASE}/bookings`);
    expect(fallback.data[0].start).toBe("2035-01-08T09:00:00.000Z");

    // One page deep: the nearest booking has to survive the limit, not just
    // the sort.
    const firstPage = await ok("GET", `${BASE}/bookings?order=asc&limit=1`);
    expect(firstPage.total).toBe(2);
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.data[0].start).toBe("2035-01-01T09:00:00.000Z");
  });
});

describe("live listing", () => {
  /** "Who is coming on Thursday" is not answered by a list that includes the
   *  person who cancelled — and the count has to drop with the row, or the
   *  pager claims a page that is not there. */
  test("live drops what no longer stands, and the total drops with it", async () => {
    await makeResource();
    const kept = await ok("POST", `${BASE}/bookings`, {
      resource: "clinic",
      start: "2035-02-05T09:00:00.000Z",
      name: "Coming",
    });
    const gone = await ok("POST", `${BASE}/bookings`, {
      resource: "clinic",
      start: "2035-02-12T09:00:00.000Z",
      name: "Cancelled",
    });
    await ok("POST", `${BASE}/bookings/${gone.data.booking.id}/cancel`, {});

    const everything = await ok("GET", `${BASE}/bookings`);
    expect(everything.total).toBe(2);

    const live = await ok("GET", `${BASE}/bookings?live=true`);
    expect(live.total).toBe(1);
    expect(live.data[0].id).toBe(kept.data.booking.id);

    // `live=false` is the string "false", which a coerced boolean would read
    // as true and quietly hide the cancellation.
    const off = await ok("GET", `${BASE}/bookings?live=false`);
    expect(off.total).toBe(2);

    // An explicit status is still answerable alongside it.
    const cancelled = await ok("GET", `${BASE}/bookings?status=cancelled`);
    expect(cancelled.total).toBe(1);
  });

  test("a lapsed hold does not stand either", async () => {
    const { listBookings } = await import("../src/server/services/booking");
    await makeResource();
    const held = await ok("POST", `${BASE}/bookings`, {
      resource: "clinic",
      start: "2035-03-05T09:00:00.000Z",
      name: "Never paid",
      hold: true,
    });
    expect(held.data.booking.status).toBe("held");

    const ctx = await ctxOf();
    const tid = tenantId();
    const after = held.data.booking.holdExpiresAt + 1000;
    expect((await listBookings(ctx, tid, { live: true }, after)).total).toBe(0);
    // Only the clock decides — the row still says `held`.
    expect((await listBookings(ctx, tid, { live: true }, after - 2000)).total).toBe(1);
  });
});

describe("the manage link", () => {
  const book = async () => {
    const created = await makeResource();
    const out = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      name: "Ada",
      email: "ada@example.com",
    });
    const token = String(out.data.manageUrl).split("/").pop()!;
    return { created, token };
  };

  test("it resolves to the booker's view and nothing more", async () => {
    const { token } = await book();
    const out = await ok("GET", `${PUBLIC}/manage/${token}`);
    expect(out.data.customerName).toBe("Ada");
    expect(out.data.canCancel).toBe(true);
    // The operator's notes, the mirror target and the source are not the
    // customer's business.
    expect(out.data).not.toHaveProperty("notes");
    expect(out.data).not.toHaveProperty("mirrorCollection");
    expect(out.data).not.toHaveProperty("source");
  });

  test("cancelling is idempotent", async () => {
    const { token } = await book();
    const first = await ok("POST", `${PUBLIC}/manage/${token}/cancel`, { reason: "Ill" });
    expect(first.data.status).toBe("cancelled");
    // A second click on the link in the confirmation mail is not an error.
    const second = await ok("POST", `${PUBLIC}/manage/${token}/cancel`);
    expect(second.data.status).toBe("cancelled");
    expect(second.data.cancelReason).toBe("Ill");
  });

  test("a cancelled slot returns to the grid", async () => {
    const { created, token } = await book();
    await ok("POST", `${PUBLIC}/manage/${token}/cancel`);
    const out = await ok("GET", `${PUBLIC}/${created.token}/slots?from=${SUNDAY}`);
    expect(out.data.slots.map((s: any) => s.start)).toContain(MONDAY_0900);
  });

  test("rescheduling spends the old link and keeps the trail", async () => {
    const { token } = await book();
    const moved = await ok("POST", `${PUBLIC}/manage/${token}/reschedule`, {
      start: mondayAt(10),
    });
    expect(moved.data.booking.start).toBe(mondayAt(10));

    // The old link is spent — it now resolves to the cancelled original.
    const old = await ok("GET", `${PUBLIC}/manage/${token}`);
    expect(old.data.status).toBe("cancelled");
    expect(old.data.canCancel).toBe(false);

    // And the trail from old to new survives on the admin side.
    const list = await ok("GET", `${BASE}/bookings`);
    const original = list.data.find((b: any) => b.cancelReason === "Rescheduled");
    expect(original.rescheduledToId).toBe(moved.data.booking.id);
  });

  test("a reschedule onto a taken slot leaves the original alone", async () => {
    const { created, token } = await book();
    // Somebody else takes 10:00 first.
    await ok("POST", `${PUBLIC}/${created.token}`, {
      start: mondayAt(10),
      email: "b@example.com",
    });

    const clash = await h.fetch(
      `${PUBLIC}/manage/${token}/reschedule`,
      json("POST", { start: mondayAt(10) }),
    );
    expect(clash.status).toBe(409);

    // The customer still has the appointment they had.
    const still = await ok("GET", `${PUBLIC}/manage/${token}`);
    expect(still.data.status).toBe("confirmed");
    expect(still.data.start).toBe(MONDAY_0900);
  });

  test("an unknown manage token refuses like every other one", async () => {
    const res = await h.fetch(`${PUBLIC}/manage/bkm_${"0".repeat(48)}`);
    expect(res.status).toBe(404);
  });
});

describe("operator actions", () => {
  test("a no-show is distinct from a cancellation", async () => {
    await makeResource();
    const made = await ok("POST", `${BASE}/bookings`, {
      resource: "clinic",
      start: "2020-01-06T09:00:00.000Z",
      end: "2020-01-06T09:30:00.000Z",
      name: "Absent",
    });
    const out = await ok("POST", `${BASE}/bookings/${made.data.booking.id}/no-show`);
    expect(out.data.status).toBe("no_show");
  });

  test("cancelling with notify:false spares the customer an email", async () => {
    const created = await makeResource();
    const made = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      email: "ada@example.com",
    });
    emails.length = 0;
    await ok("POST", `${BASE}/bookings/${made.data.booking.id}/cancel`, { notify: false });
    expect(emails).toHaveLength(0);
  });
});

describe("the unique-violation check", () => {
  // This is the shape that got through: bun:sqlite puts the engine's words on
  // the top-level message, so a check reading only `err.message` passes every
  // test here — and then a lost race on D1 answers 500 instead of "that time
  // was taken", because drizzle wraps the driver error and the real text is on
  // `cause`. Both shapes are pinned so the next driver change is caught here.
  test("recognises the flat bun:sqlite shape", () => {
    expect(isUniqueViolation(new Error("UNIQUE constraint failed: bookings.seat"))).toBe(true);
  });

  test("recognises the D1 shape, where drizzle wraps the driver error", () => {
    const wrapped = new Error('Failed query: insert into "bookings" …', {
      cause: new Error(
        "D1_ERROR: UNIQUE constraint failed: bookings.resource_id, bookings.start_at, bookings.seat: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
      ),
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  test("recognises the Postgres shape", () => {
    expect(isUniqueViolation({ code: "23505", message: "duplicate key value violates …" })).toBe(true);
  });

  test("does not swallow an unrelated failure", () => {
    // A miss here would turn a genuine error into "that time was taken", which
    // is a lie; the seat walk would also keep retrying against a broken table.
    expect(isUniqueViolation(new Error("no such table: bookings"))).toBe(false);
    expect(isUniqueViolation(new Error("network"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("what a stranger may not reach", () => {
  test("a booking is never broadcast on the realtime bus", async () => {
    // `gateForChannel` leaves an unrecognised channel name open to anyone, and
    // a payload that is not item-shaped gets no per-subscriber filter — so a
    // booking put on the bus would stream a customer's name, address and phone
    // number to whoever opened an SSE stream. Bookings therefore reach their
    // handlers through `dispatchEventHandlers`, never `publishEvent`.
    const { subscribeLocal } = await import("../src/server/services/events");
    const seen: unknown[] = [];

    const created = await makeResource();
    // BOTH addresses. A room is keyed on (workspace, channel) since realtime
    // namespacing landed, so listening on only one of them would make this
    // assertion vacuous the moment a publish used the other — one carrying the
    // resource's workspace, or one that forgot to and landed on the
    // instance-global room. See [[negative-assertions-need-the-loaded-state]].
    // The resource is created first because the workspace is read off its row.
    const stops = [tenantId(), null].map((tid) =>
      subscribeLocal({ tenantId: tid, channel: "booking" }, {
        send: (data: string) => seen.push(data),
      } as never),
    );
    await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      name: "Ada",
      email: "ada@example.com",
      phone: "+15551234",
    });
    await new Promise((r) => setTimeout(r, 50));
    for (const stop of stops) stop();

    expect(seen).toHaveLength(0);
  });

  test("the public path cannot write the operator's notes column", async () => {
    const created = await makeResource();
    await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      email: "ada@example.com",
      notes: "INJECTED",
    });
    const list = await ok("GET", `${BASE}/bookings`);
    // Dropped by the schema rather than stored — `notes` is the operator's
    // column, and a mirror map can project it into a workspace collection.
    expect(list.data[0].notes).toBeNull();
  });

  test("the public path cannot park a slot with a hold, or choose its own end", async () => {
    const created = await makeResource();
    const out = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      email: "ada@example.com",
      hold: true,
      end: mondayAt(17),
    });
    expect(out.data.booking.status).toBe("confirmed");
    expect(Date.parse(out.data.booking.end) - Date.parse(out.data.booking.start)).toBe(30 * 60_000);
  });
});

describe("the mirrored row", () => {
  test("a booking lands in the workspace's own collection", async () => {
    await ok("POST", "/api/collections", {
      slug: "appointments",
      fields: [
        { name: "starts_at", type: "text" },
        { name: "patient", type: "text" },
        { name: "state", type: "text" },
      ],
    });
    const created = await makeResource({
      key: "mirrored",
      mirrorCollection: "appointments",
      mirrorFieldMap: { start: "starts_at", name: "patient", status: "state" },
    });

    const made = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      name: "Ada",
      email: "ada@example.com",
    });
    expect(made.data.booking.id).toBeTruthy();

    const items = await ok("GET", "/api/items/appointments");
    expect(items.data).toHaveLength(1);
    expect(items.data[0].patient).toBe("Ada");
    expect(items.data[0].state).toBe("confirmed");

    // And the status follows the booking.
    const token = String(made.data.manageUrl).split("/").pop()!;
    await ok("POST", `${PUBLIC}/manage/${token}/cancel`);
    const after = await ok("GET", "/api/items/appointments");
    expect(after.data[0].state).toBe("cancelled");
  });

  test("a broken mirror does not cost the customer their booking", async () => {
    const created = await makeResource({
      key: "broken",
      mirrorCollection: "does_not_exist",
      mirrorFieldMap: { name: "who" },
    });
    const made = await ok("POST", `${PUBLIC}/${created.token}`, {
      start: MONDAY_0900,
      email: "ada@example.com",
    });
    // The slot is held and the appointment is real; the failure shows up as a
    // booking with no mirrored row rather than as a 500 for the customer.
    expect(made.data.booking.status).toBe("confirmed");
    const list = await ok("GET", `${BASE}/bookings`);
    expect(list.data[0].mirrorItemId).toBeNull();
  });
});
