/**
 * Date-relative flow triggers and the `foreach` op (#37).
 *
 * What this file pins, in order of how expensive it is to get wrong:
 *
 *  1. **Exactly-once.** The scan deliberately re-reads a two-day catch-up
 *     window on every tick, so without the fire ledger every reminder would go
 *     out again every minute for two days. Two ticks must produce one run — and
 *     so must two ticks whose windows overlap, which is the normal case.
 *  2. **The backlog is not blasted.** Switching a schedule on over rows that
 *     were already overdue must send nothing. This is the failure an operator
 *     cannot take back.
 *  3. **A moved date fires again.** The corrected reminder is the one that
 *     matters most, and keying the ledger on (flow, row) alone would suppress
 *     exactly that.
 *  4. **The wall-clock math survives DST**, including the spring-forward gap
 *     where the requested time does not exist.
 *  5. **The save-time refusals hold on EVERY surface.** A `foreach` that
 *     suspends, or one nested in another, is a loop that silently runs once —
 *     and GraphQL must refuse what REST refuses.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SCHEDULE_CATCHUP_MS,
  type ScheduleSpec,
  fireInstant,
  findForeachViolation,
  firesWithin,
  formatScheduleTrigger,
  parseScheduleTrigger,
  scanRange,
  validateScheduleSpec,
} from "@backlex/core";
import { createClient } from "../../../packages/client/src/index";
import { buildContext, type Ctx } from "../src/server/context";
import { runDueScheduleFlows, pruneScheduleFires } from "../src/server/services/flow-schedules";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };

// ── The pure half ───────────────────────────────────────────────────────────
// No clock, no database. Driving this through HTTP would only make a DST
// failure harder to read.

const spec = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  collection: "invoices",
  field: "due_date",
  offset: { value: 3, unit: "days", direction: "before" },
  at: null,
  timeZone: null,
  where: null,
  ...over,
});

describe("fire instant (pure)", () => {
  test("without a time of day it is a constant shift from the field", () => {
    const due = Date.UTC(2026, 7, 20, 14, 30);
    const got = fireInstant(due, spec());
    expect(got).toBe(due - 3 * 86_400_000);
    // …and the shift keeps the field's own time of day, which is the whole
    // reason `at` is optional.
    expect(new Date(got!).getUTCHours()).toBe(14);
    expect(new Date(got!).getUTCMinutes()).toBe(30);
  });

  test("`after` moves forward", () => {
    const base = Date.UTC(2026, 7, 20);
    expect(fireInstant(base, spec({ offset: { value: 2, unit: "hours", direction: "after" } }))).toBe(
      base + 2 * 3_600_000,
    );
  });

  test("with a time of day it lands on that wall clock in the zone", () => {
    // 20 Aug 2026 is inside Istanbul's fixed +03:00; three days before, 09:00
    // local is 06:00Z on the 17th.
    const got = fireInstant(
      Date.UTC(2026, 7, 20, 12, 0),
      spec({ at: 9 * 60, timeZone: "Europe/Istanbul" }),
    );
    expect(new Date(got!).toISOString()).toBe("2026-08-17T06:00:00.000Z");
  });

  test("the civil date is read IN THE ZONE, not in UTC", () => {
    // 22:30 UTC on the 19th is already 01:30 on the 20th in Istanbul. Counting
    // from the UTC date would fire a day early — the classic off-by-one that
    // only shows up for evening timestamps.
    const got = fireInstant(
      Date.UTC(2026, 7, 19, 22, 30),
      spec({
        offset: { value: 1, unit: "days", direction: "before" },
        at: 9 * 60,
        timeZone: "Europe/Istanbul",
      }),
    );
    expect(new Date(got!).toISOString()).toBe("2026-08-19T06:00:00.000Z");
  });

  test("a wall clock survives a DST transition in between", () => {
    // Berlin leaves DST on 25 Oct 2026. "Three days before, at 09:00" from the
    // 27th must still be 09:00 local on the 24th — which is 07:00Z, not the
    // 08:00Z a constant-millisecond shift would give.
    const got = fireInstant(
      Date.UTC(2026, 9, 27, 12, 0),
      spec({ at: 9 * 60, timeZone: "Europe/Berlin" }),
    );
    expect(new Date(got!).toISOString()).toBe("2026-10-24T07:00:00.000Z");
  });

  test("a time that does not exist fires nothing rather than being rounded", () => {
    // Berlin springs forward at 02:00 on 29 Mar 2026; 02:30 never happens.
    // Rounding to 03:30 would tell somebody a time they were never promised.
    const got = fireInstant(
      Date.UTC(2026, 2, 30, 12, 0),
      spec({
        offset: { value: 1, unit: "days", direction: "before" },
        at: 2 * 60 + 30,
        timeZone: "Europe/Berlin",
      }),
    );
    expect(got).toBeNull();
  });

  test("an unreadable field value is null, never NaN", () => {
    // NaN compares false against everything, so it reads exactly like "not due
    // yet" — forever, and silently.
    for (const bad of [null, undefined, "", "not a date", {}, []]) {
      expect(fireInstant(bad, spec())).toBeNull();
    }
    // The shapes a timestamp column actually arrives in all work.
    const ms = Date.UTC(2026, 7, 20);
    expect(fireInstant(ms, spec())).toBe(ms - 3 * 86_400_000);
    expect(fireInstant(new Date(ms), spec())).toBe(ms - 3 * 86_400_000);
    expect(fireInstant("2026-08-20T00:00:00.000Z", spec())).toBe(ms - 3 * 86_400_000);
    // A bare integer string is epoch ms — Date.parse would give NaN here.
    expect(fireInstant(String(ms), spec())).toBe(ms - 3 * 86_400_000);
  });
});

describe("scan range (pure)", () => {
  test("inverts the window exactly when no wall clock is involved", () => {
    const from = Date.UTC(2026, 7, 1);
    const to = from + 60_000;
    const r = scanRange(spec(), from, to);
    expect(r.minMs).toBe(from + 3 * 86_400_000);
    expect(r.maxMs).toBe(to + 3 * 86_400_000);
  });

  test("over-fetches by a day either side when a wall clock is", () => {
    const from = Date.UTC(2026, 7, 1);
    const to = from + 60_000;
    const exact = scanRange(spec(), from, to);
    const loose = scanRange(spec({ at: 9 * 60 }), from, to);
    expect(loose.minMs).toBe(exact.minMs - 86_400_000);
    expect(loose.maxMs).toBe(exact.maxMs + 86_400_000);
  });

  test("the window is half-open so adjacent ticks cannot both claim an instant", () => {
    expect(firesWithin(100, 100, 200)).toBe(false); // the previous tick's `to`
    expect(firesWithin(200, 100, 200)).toBe(true);
    expect(firesWithin(null, 0, 10 ** 12)).toBe(false);
  });
});

describe("trigger round-trip + validation (pure)", () => {
  test("a spec survives the flows.trigger column", () => {
    const s = spec({ at: 540, timeZone: "Europe/Istanbul", where: { status: { _neq: "paid" } } });
    expect(parseScheduleTrigger(formatScheduleTrigger(s))).toEqual(s);
  });

  test("a non-schedule or malformed trigger is null, not a throw", () => {
    // This runs across every flow in the instance inside the tick; one bad row
    // must not stop everyone else's reminders.
    expect(parseScheduleTrigger("cron:0 9 * * *")).toBeNull();
    expect(parseScheduleTrigger("schedule:")).toBeNull();
    expect(parseScheduleTrigger("schedule:{oops")).toBeNull();
    expect(parseScheduleTrigger('schedule:{"collection":"x"}')).toBeNull();
  });

  test("a time of day cannot be paired with an hour offset", () => {
    expect(
      validateScheduleSpec(spec({ at: 540, offset: { value: 2, unit: "hours", direction: "before" } })),
    ).toContain("time of day");
    expect(validateScheduleSpec(spec({ at: 540 }))).toBeNull();
  });

  test("an unknown time zone is refused at save rather than silently becoming UTC", () => {
    expect(validateScheduleSpec(spec({ at: 540, timeZone: "Mars/Olympus" }))).toContain(
      "Unknown time zone",
    );
  });
});

describe("foreach placement (pure)", () => {
  const loop = (body: unknown[]) => [
    { type: "foreach", collection: "invoices", do: body },
  ];

  test("a nested foreach is refused", () => {
    expect(findForeachViolation(loop([{ type: "foreach", collection: "x", do: [] }]))).toContain(
      "another foreach",
    );
  });

  test("a suspending delay inside a loop is refused, a short one is not", () => {
    expect(findForeachViolation(loop([{ type: "delay", durationMs: 60_000 }]))).toContain("delay");
    expect(findForeachViolation(loop([{ type: "delay", durationMs: 5_000 }]))).toBeNull();
  });

  test("the check reaches through branches inside the loop", () => {
    expect(
      findForeachViolation(
        loop([{ type: "condition", filter: {}, then: [{ type: "delay", durationMs: 90_000 }] }]),
      ),
    ).toContain("delay");
  });

  test("a long delay OUTSIDE a loop is fine", () => {
    expect(findForeachViolation([{ type: "delay", durationMs: 600_000 }])).toBeNull();
  });
});

// ── The half that touches a database ────────────────────────────────────────

describe("the scan, the ledger, and the fan-out", () => {
  let h: TestHarness;
  let ctx: Ctx;
  const slug = "sched_invoices";

  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await h.fetch(path, {
      method,
      headers: JSON_HEADERS,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json()) as any;
    if (res.status >= 400) {
      throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`);
    }
    return parsed;
  };

  /** Rows the flow wrote, which is how we count how many times it ran. */
  const sent = async (): Promise<string[]> => {
    const res = await ok("GET", "/api/items/sched_log");
    return (res.data as Array<{ note: string }>).map((r) => r.note).sort();
  };

  const ledgerCount = (): number => {
    const client = new Database(h.env.SQLITE_PATH as string);
    try {
      return (
        client.query("SELECT COUNT(*) AS n FROM flow_schedule_fires").get() as { n: number }
      ).n;
    } finally {
      client.close();
    }
  };

  const makeFlow = async (over: Partial<ScheduleSpec> = {}) =>
    ok("POST", "/api/flows", {
      name: "due-soon",
      trigger: formatScheduleTrigger(spec({ collection: slug, ...over })),
      operations: [
        {
          type: "item.create",
          collection: "sched_log",
          data: { note: "{{ data.number }}" },
        },
      ],
    });

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await ok("POST", "/api/collections", {
      slug,
      fields: [
        { name: "number", type: "text" },
        { name: "due_date", type: "timestamp" },
        { name: "status", type: "text" },
      ],
    });
    await ok("POST", "/api/collections", {
      slug: "sched_log",
      fields: [{ name: "note", type: "text" }],
    });
    ctx = await buildContext(h.env);
  });
  afterEach(() => h.cleanup());

  const addInvoice = async (number: string, dueAtMs: number, status = "unpaid") =>
    ok("POST", `/api/items/${slug}`, {
      number,
      due_date: new Date(dueAtMs).toISOString(),
      status,
    });

  /**
   * A due date chosen so that the schedule's "three days before" instant lands
   * exactly on `instantMs`.
   *
   * Every test here has to place instants relative to when the FLOW was
   * created, not to when the row was: the scan's left edge is the flow's own
   * creation, so an instant before that is history the flow deliberately does
   * not relive. Writing the due dates by hand made that easy to get subtly
   * wrong, which is the whole reason this helper exists.
   */
  const dueForInstantAt = (instantMs: number) => instantMs + 3 * 86_400_000;

  test("a row whose instant has arrived fires exactly once, however many ticks run", async () => {
    await makeFlow();
    const base = Date.now();
    await addInvoice("INV-1", dueForInstantAt(base + 60_000));

    await runDueScheduleFlows(ctx, new Date(base + 120_000));
    expect(await sent()).toEqual(["INV-1"]);
    expect(ledgerCount()).toBe(1);

    // Three more ticks, all with overlapping catch-up windows — the normal
    // case, and the one that would re-send every minute without the ledger.
    await runDueScheduleFlows(ctx, new Date(base + 180_000));
    await runDueScheduleFlows(ctx, new Date(base + 3_600_000));
    await runDueScheduleFlows(ctx, new Date(base + 86_400_000));
    expect(await sent()).toEqual(["INV-1"]);
    expect(ledgerCount()).toBe(1);
  });

  test("a row not yet due, and one already past the catch-up window, both stay quiet", async () => {
    await makeFlow();
    const base = Date.now();
    await addInvoice("FUTURE", dueForInstantAt(base + 7 * 86_400_000));
    await addInvoice("ANCIENT", dueForInstantAt(base - 30 * 86_400_000));

    await runDueScheduleFlows(ctx, new Date(base + 120_000));
    expect(await sent()).toEqual([]);
  });

  test("switching a schedule on does not blast the rows that were already overdue", async () => {
    // The failure an operator cannot take back: every overdue invoice mailed at
    // once, the minute the flow is saved. Both of these have instants inside the
    // catch-up window, so only the flow's own creation keeps them quiet.
    const base = Date.now();
    await addInvoice("OLD-1", dueForInstantAt(base - 36 * 3_600_000));
    await addInvoice("OLD-2", dueForInstantAt(base - 12 * 3_600_000));
    await makeFlow();

    await runDueScheduleFlows(ctx, new Date(base + 120_000));
    expect(await sent()).toEqual([]);
  });

  test("the catch-up window still covers ticks that never ran", async () => {
    await makeFlow();
    const base = Date.now();
    // The instant lands a minute from now, but nothing ticks for six hours —
    // a restart, a deploy, a cold gap. A scan driven by a one-minute window
    // would have lost this reminder with no trace.
    await addInvoice("MISSED", dueForInstantAt(base + 60_000));

    await runDueScheduleFlows(ctx, new Date(base + 6 * 3_600_000));
    expect(await sent()).toEqual(["MISSED"]);
  });

  test("moving the due date fires again; leaving it alone does not", async () => {
    await makeFlow();
    const base = Date.now();
    const created = await addInvoice("INV-9", dueForInstantAt(base + 60_000));
    await runDueScheduleFlows(ctx, new Date(base + 120_000));
    expect(await sent()).toEqual(["INV-9"]);

    // A no-op edit must not re-fire: the instant is unchanged, so the claim
    // still collides with the entry already in the ledger.
    await ok("PATCH", `/api/items/${slug}/${created.data.id}`, { status: "sent" });
    await runDueScheduleFlows(ctx, new Date(base + 180_000));
    expect(await sent()).toEqual(["INV-9"]);

    // Moving the date is a NEW instant — and the corrected reminder is the one
    // the operator most wants to arrive.
    await ok("PATCH", `/api/items/${slug}/${created.data.id}`, {
      due_date: new Date(dueForInstantAt(base + 240_000)).toISOString(),
    });
    await runDueScheduleFlows(ctx, new Date(base + 300_000));
    expect(await sent()).toEqual(["INV-9", "INV-9"]);
  });

  test("the `where` filter narrows what fires, in SQL", async () => {
    await makeFlow({ where: { status: { _neq: "paid" } } });
    const base = Date.now();
    await addInvoice("UNPAID", dueForInstantAt(base + 60_000), "unpaid");
    await addInvoice("PAID", dueForInstantAt(base + 60_000), "paid");

    await runDueScheduleFlows(ctx, new Date(base + 120_000));
    expect(await sent()).toEqual(["UNPAID"]);
  });

  test("a deleted row is not reminded about", async () => {
    await makeFlow();
    const base = Date.now();
    const created = await addInvoice("GONE", dueForInstantAt(base + 60_000));
    await ok("DELETE", `/api/items/${slug}/${created.data.id}`);

    await runDueScheduleFlows(ctx, new Date(base + 120_000));
    expect(await sent()).toEqual([]);
  });

  test("a paused flow fires nothing", async () => {
    const flow = await makeFlow();
    await ok("PATCH", `/api/flows/${flow.data.id}`, { active: false });
    const base = Date.now();
    await addInvoice("PAUSED", dueForInstantAt(base + 60_000));

    await runDueScheduleFlows(ctx, new Date(base + 120_000));
    expect(await sent()).toEqual([]);
  });

  test("a time-of-day schedule fires on the wall clock, not the row's own hour", async () => {
    // The end-to-end version of the civil-space math: whatever hour the due
    // date carries, the reminder goes out at 09:00 in the workspace's zone.
    const zone = "Europe/Istanbul";
    await makeFlow({
      offset: { value: 1, unit: "days", direction: "before" },
      at: 9 * 60,
      timeZone: zone,
    });
    const base = Date.now();
    // Due tomorrow at whatever time it happens to be now → the instant is 09:00
    // Istanbul TODAY, which may be behind or ahead of `base`.
    const due = base + 86_400_000;
    await addInvoice("WALL", due);
    const expected = fireInstant(due, {
      offset: { value: 1, unit: "days", direction: "before" },
      at: 9 * 60,
      timeZone: zone,
    })!;

    // Tick a minute past the computed instant; if it is already behind us the
    // catch-up window covers it, provided it is not before the flow existed.
    await runDueScheduleFlows(ctx, new Date(Math.max(expected, base) + 60_000));
    expect(await sent()).toEqual(expected >= base ? ["WALL"] : []);
  });

  test("pruning drops only what a scan can never reach again", async () => {
    await makeFlow();
    const base = Date.now();
    await addInvoice("KEEP", dueForInstantAt(base + 60_000));
    await runDueScheduleFlows(ctx, new Date(base + 120_000));
    expect(ledgerCount()).toBe(1);

    // Still inside the safety margin (two catch-up windows) → kept.
    await pruneScheduleFires(ctx, new Date(base + SCHEDULE_CATCHUP_MS));
    expect(ledgerCount()).toBe(1);

    // Past it → an entry down there can never be consulted by a scan again.
    await pruneScheduleFires(ctx, new Date(base + SCHEDULE_CATCHUP_MS * 2 + 120_000));
    expect(ledgerCount()).toBe(0);
  });
});

// ── foreach ─────────────────────────────────────────────────────────────────

describe("the foreach op", () => {
  let h: TestHarness;
  const slug = "loop_people";

  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await h.fetch(path, {
      method,
      headers: JSON_HEADERS,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json()) as any;
    if (res.status >= 400) {
      throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`);
    }
    return parsed;
  };

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await ok("POST", "/api/collections", {
      slug,
      fields: [
        { name: "name", type: "text" },
        { name: "active", type: "text" },
      ],
    });
    await ok("POST", "/api/collections", {
      slug: "loop_log",
      fields: [{ name: "note", type: "text" }],
    });
  });
  afterEach(() => h.cleanup());

  const runLoop = async (op: Record<string, unknown>) => {
    const flow = await ok("POST", "/api/flows", {
      name: "loop",
      trigger: "manual",
      operations: [op],
    });
    await ok("POST", `/api/flows/${flow.data.id}/run`, {});
    const res = await ok("GET", "/api/items/loop_log");
    return (res.data as Array<{ note: string }>).map((r) => r.note).sort();
  };

  test("the body runs once per row with `$item` bound", async () => {
    await ok("POST", `/api/items/${slug}`, { name: "ada", active: "yes" });
    await ok("POST", `/api/items/${slug}`, { name: "bob", active: "no" });

    expect(
      await runLoop({
        type: "foreach",
        collection: slug,
        do: [
          { type: "item.create", collection: "loop_log", data: { note: "{{ $item.name }}" } },
        ],
      }),
    ).toEqual(["ada", "bob"]);
  });

  test("`filter` narrows the rows the loop visits", async () => {
    await ok("POST", `/api/items/${slug}`, { name: "ada", active: "yes" });
    await ok("POST", `/api/items/${slug}`, { name: "bob", active: "no" });

    expect(
      await runLoop({
        type: "foreach",
        collection: slug,
        filter: { active: { _eq: "yes" } },
        do: [
          { type: "item.create", collection: "loop_log", data: { note: "{{ $item.name }}" } },
        ],
      }),
    ).toEqual(["ada"]);
  });

  test("`limit` bounds the loop", async () => {
    for (const name of ["a", "b", "c"]) {
      await ok("POST", `/api/items/${slug}`, { name, active: "yes" });
    }
    const notes = await runLoop({
      type: "foreach",
      collection: slug,
      sort: "name",
      limit: 2,
      do: [{ type: "item.create", collection: "loop_log", data: { note: "{{ $item.name }}" } }],
    });
    expect(notes).toEqual(["a", "b"]);
  });

  test("`$item` does not leak out of the loop", async () => {
    await ok("POST", `/api/items/${slug}`, { name: "ada", active: "yes" });
    const flow = await ok("POST", "/api/flows", {
      name: "leak",
      trigger: "manual",
      operations: [
        {
          type: "foreach",
          collection: slug,
          do: [{ type: "log", message: "{{ $item.name }}" }],
        },
        // Outside the loop there is no current row, so this must interpolate to
        // empty rather than to whatever the last iteration happened to hold.
        { type: "item.create", collection: "loop_log", data: { note: "after:{{ $item.name }}" } },
      ],
    });
    await ok("POST", `/api/flows/${flow.data.id}/run`, {});
    const res = await ok("GET", "/api/items/loop_log");
    expect((res.data as Array<{ note: string }>)[0]!.note).toBe("after:");
  });
});

// ── save-time refusals, on every surface ────────────────────────────────────

describe("what cannot be saved", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: "guard_rows",
        fields: [
          { name: "name", type: "text" },
          { name: "due_date", type: "timestamp" },
        ],
      }),
    });
  });
  afterAll(() => h.cleanup());

  const post = async (body: unknown) => {
    const res = await h.fetch("/api/flows", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const gql = async (query: string, variables: Record<string, unknown>) => {
    const res = await h.fetch("/api/graphql", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as any;
  };

  const CREATE = `mutation ($data: FlowInput!) { createFlow(data: $data) { id } }`;

  const loopFlow = (body: unknown[]) => ({
    name: "bad-loop",
    trigger: "manual",
    operations: [{ type: "foreach", collection: "guard_rows", do: body }],
  });

  test("a foreach nested in a foreach is refused", async () => {
    const r = await post(loopFlow([{ type: "foreach", collection: "guard_rows", do: [{ type: "log", message: "x" }] }]));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("another foreach");
  });

  test("a suspending delay inside a foreach is refused", async () => {
    const r = await post(loopFlow([{ type: "delay", durationMs: 600_000 }]));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("foreach");
  });

  test("an approval inside a foreach is refused", async () => {
    const r = await post(
      loopFlow([{ type: "approval.request", title: "ok?", approvers: [{ email: "a@b.test" }] }]),
    );
    expect(r.status).toBe(422);
  });

  test("a foreach over a collection that does not exist is refused", async () => {
    const r = await post({
      name: "ghost",
      trigger: "manual",
      operations: [{ type: "foreach", collection: "nope_not_here", do: [{ type: "log", message: "x" }] }],
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("nope_not_here");
  });

  test("a schedule counting from a non-date field is refused", async () => {
    const r = await post({
      name: "bad-field",
      trigger: formatScheduleTrigger(spec({ collection: "guard_rows", field: "name" })),
      operations: [{ type: "log", message: "x" }],
    });
    expect(r.status).toBe(422);
    // The point of the message is that it names WHY, since a schedule on a text
    // field does not misfire — it never fires at all.
    expect(JSON.stringify(r.body)).toContain("text");
  });

  test("a schedule naming a field that is not there is refused", async () => {
    const r = await post({
      name: "ghost-field",
      trigger: formatScheduleTrigger(spec({ collection: "guard_rows", field: "nope" })),
      operations: [{ type: "log", message: "x" }],
    });
    expect(r.status).toBe(422);
  });

  test("a filter operator the engine cannot read is refused", async () => {
    // The sharpest edge in this feature, and it fails OPEN: the compiler skips
    // what it does not recognise, an empty comparison leaves an empty AND, and
    // an empty AND is TRUE. So `$ne` instead of `_neq` does not narrow the scan
    // — it matches every row, and every customer gets the reminder.
    const r = await post({
      name: "typo",
      trigger: formatScheduleTrigger(
        spec({ collection: "guard_rows", field: "due_date", where: { name: { $ne: "x" } } as never }),
      ),
      operations: [{ type: "log", message: "x" }],
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("$ne");

    const loop = await post({
      name: "typo-loop",
      trigger: "manual",
      operations: [
        {
          type: "foreach",
          collection: "guard_rows",
          filter: { name: { equals: "x" } },
          do: [{ type: "log", message: "x" }],
        },
      ],
    });
    expect(loop.status).toBe(422);

    // …and the real spelling still saves.
    const good = await post({
      name: "typo-fixed",
      trigger: "manual",
      operations: [
        {
          type: "foreach",
          collection: "guard_rows",
          filter: { name: { _neq: "x" } },
          do: [{ type: "log", message: "x" }],
        },
      ],
    });
    expect(good.status).toBe(201);
  });

  test("a filter written as a bare value is refused", async () => {
    // The same fail-open as the typo above, reached by the likelier mistake:
    // `{ status: "paid" }` is what a filter looks like in most JSON APIs, and
    // this DSL has no such shorthand. It carries no operator, so it compiles to
    // no SQL at all and the "only unpaid invoices" schedule mails everyone.
    const r = await post({
      name: "bare",
      trigger: formatScheduleTrigger(
        spec({ collection: "guard_rows", field: "due_date", where: { status: "paid" } as never }),
      ),
      operations: [{ type: "log", message: "x" }],
    });
    expect(r.status).toBe(422);
    // Names the field AND shows the shape that was meant — the author has to be
    // able to fix it from the message alone.
    expect(JSON.stringify(r.body)).toContain("status");
    expect(JSON.stringify(r.body)).toContain("_eq");

    // An empty comparison object collapses the same way.
    const empty = await post({
      name: "empty-cmp",
      trigger: "manual",
      operations: [
        {
          type: "foreach",
          collection: "guard_rows",
          filter: { name: {} } as never,
          do: [{ type: "log", message: "x" }],
        },
      ],
    });
    expect(empty.status).toBe(422);

    // A bare value nested under $and is caught at the same depth the compiler
    // would have flattened it.
    const nested = await post({
      name: "bare-nested",
      trigger: "manual",
      operations: [
        {
          type: "foreach",
          collection: "guard_rows",
          filter: { $and: [{ name: { _neq: "x" } }, { status: "paid" }] } as never,
          do: [{ type: "log", message: "x" }],
        },
      ],
    });
    expect(nested.status).toBe(422);
  });

  test("a valid schedule saves", async () => {
    const r = await post({
      name: "good",
      trigger: formatScheduleTrigger(spec({ collection: "guard_rows", field: "due_date" })),
      operations: [{ type: "log", message: "x" }],
    });
    expect(r.status).toBe(201);
  });

  test("the SDK carries a schedule trigger, and inherits the same refusals", async () => {
    // The SDK and the CLI both write through `POST /api/flows`, so parity here
    // is structural rather than re-implemented — this pins that it stays that
    // way, since a surface that grows its own write path grows its own gaps.
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

    const created = await client.flows.create({
      name: "sdk-schedule",
      trigger: formatScheduleTrigger(spec({ collection: "guard_rows", field: "due_date" })),
      operations: [{ type: "log", message: "x" }],
    });
    expect(parseScheduleTrigger(created.data.trigger)?.field).toBe("due_date");

    await expect(
      client.flows.create({
        name: "sdk-bad",
        trigger: formatScheduleTrigger(spec({ collection: "guard_rows", field: "name" })),
        operations: [{ type: "log", message: "x" }],
      }),
    ).rejects.toThrow();
  });

  test("GraphQL refuses exactly what REST refuses", async () => {
    // The guard shipped on the REST route alone once before. A surface that
    // re-implements its own checks is a surface that is one commit away from
    // not having them.
    const nested = await gql(CREATE, { data: loopFlow([{ type: "foreach", collection: "guard_rows", do: [{ type: "log", message: "x" }] }]) });
    expect(nested.errors?.[0]?.message).toContain("another foreach");
    expect(nested.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const badField = await gql(CREATE, {
      data: {
        name: "gql-bad",
        trigger: formatScheduleTrigger(spec({ collection: "guard_rows", field: "name" })),
        operations: [{ type: "log", message: "x" }],
      },
    });
    expect(badField.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    // And a nested approval — the check that existed only on REST until now.
    const approval = await gql(CREATE, {
      data: {
        name: "gql-approval",
        trigger: "manual",
        operations: [
          {
            type: "condition",
            filter: {},
            then: [{ type: "approval.request", title: "ok?", approvers: [{ email: "a@b.test" }] }],
          },
        ],
      },
    });
    expect(approval.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});
