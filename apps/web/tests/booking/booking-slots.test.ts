import { describe, expect, test } from "bun:test";
import {
  availableSlots,
  bookingsConflict,
  civilDateIn,
  slotIsOffered,
  wallClockToUtc,
  weekdayOf,
  zoneOffsetMs,
  type AvailabilityRule,
  type SlotPolicy,
} from "@backlex/core";

/**
 * The slot math, exercised without a database.
 *
 * Everything here is pinned to real transition dates in real zones rather than
 * to a fabricated offset: the point of deriving offsets from `Intl` is that the
 * runtime's own tz data is the authority, and a test that invents its own would
 * only prove the invention.
 */

const ISTANBUL = "Europe/Istanbul"; // UTC+3 all year — no DST since 2016.
const BERLIN = "Europe/Berlin"; // CET/CEST, transitions on the last Sunday.

const policy = (over: Partial<SlotPolicy> = {}): SlotPolicy => ({
  timeZone: ISTANBUL,
  slotMinutes: 30,
  capacity: 1,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  leadMinutes: 0,
  horizonDays: 60,
  ...over,
});

/** Mondays 09:00–11:00. */
const mondayMorning: AvailabilityRule = {
  kind: "open",
  weekday: 1,
  startMinute: 9 * 60,
  endMinute: 11 * 60,
  startsOn: null,
  endsOn: null,
};

/** 2026-08-03 is a Monday. */
const MONDAY = Date.UTC(2026, 7, 3);
const THE_WEEK_BEFORE = Date.UTC(2026, 6, 27);

const hhmm = (ms: number, tz = ISTANBUL): string => {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
  return p;
};

describe("zone arithmetic", () => {
  test("offset is read from the runtime's own tz data", () => {
    expect(zoneOffsetMs(MONDAY, ISTANBUL)).toBe(3 * 3_600_000);
    // Berlin in August is CEST (+2), in January CET (+1).
    expect(zoneOffsetMs(Date.UTC(2026, 7, 3), BERLIN)).toBe(2 * 3_600_000);
    expect(zoneOffsetMs(Date.UTC(2026, 0, 3), BERLIN)).toBe(1 * 3_600_000);
  });

  test("a local wall clock maps to the instant it names", () => {
    const r = wallClockToUtc({ year: 2026, month: 8, day: 3 }, 9 * 60, ISTANBUL);
    expect(r.exists).toBe(true);
    expect(new Date(r.utcMs).toISOString()).toBe("2026-08-03T06:00:00.000Z");
  });

  test("the spring-forward gap is reported, not rounded", () => {
    // Berlin jumps 02:00 → 03:00 on 2026-03-29. 02:30 is not a time that day.
    const gap = wallClockToUtc({ year: 2026, month: 3, day: 29 }, 2 * 60 + 30, BERLIN);
    expect(gap.exists).toBe(false);
    // The hour on either side is untouched.
    expect(wallClockToUtc({ year: 2026, month: 3, day: 29 }, 60, BERLIN).exists).toBe(true);
    expect(wallClockToUtc({ year: 2026, month: 3, day: 29 }, 3 * 60, BERLIN).exists).toBe(true);
  });

  test("the autumn ambiguous hour resolves to the earlier instant", () => {
    // Berlin repeats 02:00–03:00 on 2026-10-25; 02:30 names two instants.
    const r = wallClockToUtc({ year: 2026, month: 10, day: 25 }, 2 * 60 + 30, BERLIN);
    expect(r.exists).toBe(true);
    expect(new Date(r.utcMs).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  test("civil dates and weekdays are DST-free", () => {
    expect(weekdayOf({ year: 2026, month: 8, day: 3 })).toBe(1);
    expect(civilDateIn(Date.UTC(2026, 7, 2, 22, 0), ISTANBUL)).toEqual({
      year: 2026,
      month: 8,
      day: 3,
    });
  });
});

describe("availableSlots", () => {
  test("a weekly rule produces slots on its own weekday only", () => {
    const slots = availableSlots({
      policy: policy(),
      rules: [mondayMorning],
      busy: [],
      from: THE_WEEK_BEFORE,
      to: THE_WEEK_BEFORE + 14 * 86_400_000,
      now: THE_WEEK_BEFORE,
    });
    // Two Mondays in a fortnight, four 30-minute slots in 09:00–11:00 each.
    expect(slots).toHaveLength(8);
    expect(slots.map((s) => hhmm(s.start)).slice(0, 4)).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
    ]);
  });

  test("rules are read in the resource's zone, not the server's", () => {
    const slots = availableSlots({
      policy: policy({ timeZone: BERLIN }),
      rules: [mondayMorning],
      busy: [],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(hhmm(slots[0]!.start, BERLIN)).toBe("09:00");
    // Same wall clock, a different instant: Berlin is +2 in August, Istanbul +3.
    expect(new Date(slots[0]!.start).toISOString()).toBe("2026-08-03T07:00:00.000Z");
  });

  test("a block subtracts from the middle of an opening", () => {
    const lunch: AvailabilityRule = {
      kind: "block",
      weekday: 1,
      startMinute: 9 * 60 + 30,
      endMinute: 10 * 60 + 30,
      startsOn: null,
      endsOn: null,
    };
    const slots = availableSlots({
      policy: policy(),
      rules: [mondayMorning, lunch],
      busy: [],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(slots.map((s) => hhmm(s.start))).toEqual(["09:00", "10:30"]);
  });

  test("a dated block closes one day and leaves the pattern alone", () => {
    const holiday: AvailabilityRule = {
      kind: "block",
      weekday: null,
      startMinute: 0,
      endMinute: 1440,
      startsOn: "2026-08-03",
      endsOn: "2026-08-03",
    };
    const slots = availableSlots({
      policy: policy(),
      rules: [mondayMorning, holiday],
      busy: [],
      from: MONDAY,
      to: MONDAY + 8 * 86_400_000,
      now: MONDAY,
    });
    // The 3rd is gone; the 10th is not.
    expect(slots).toHaveLength(4);
    expect(civilDateIn(slots[0]!.start, ISTANBUL)).toEqual({ year: 2026, month: 8, day: 10 });
  });

  test("an existing booking removes exactly the slot it occupies", () => {
    const busyStart = Date.UTC(2026, 7, 3, 6, 30); // 09:30 Istanbul
    const slots = availableSlots({
      policy: policy(),
      rules: [mondayMorning],
      busy: [{ start: busyStart, end: busyStart + 30 * 60_000 }],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(slots.map((s) => hhmm(s.start))).toEqual(["09:00", "10:00", "10:30"]);
  });

  test("both buffers have to fit between two bookings", () => {
    const busyStart = Date.UTC(2026, 7, 3, 6, 0); // 09:00–09:30
    const slots = availableSlots({
      // Preparation and clearing up are different activities: 15 either side
      // means a 30-minute gap. The 15-minute step is what makes that visible —
      // if only the existing side were charged, 09:45 would be offered.
      policy: policy({ stepMinutes: 15, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }),
      rules: [mondayMorning],
      busy: [{ start: busyStart, end: busyStart + 30 * 60_000 }],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(slots.map((s) => hhmm(s.start))).toEqual(["10:00", "10:15", "10:30"]);
  });

  test("a one-sided gap is asked for by setting one side", () => {
    const busyStart = Date.UTC(2026, 7, 3, 6, 0); // 09:00–09:30
    const slots = availableSlots({
      policy: policy({ stepMinutes: 15, bufferAfterMinutes: 15 }),
      rules: [mondayMorning],
      busy: [{ start: busyStart, end: busyStart + 30 * 60_000 }],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(slots.map((s) => hhmm(s.start))[0]).toBe("09:45");
  });

  test("the conflict rule is symmetric, so two racers cannot disagree", () => {
    const p = policy({ bufferBeforeMinutes: 0, bufferAfterMinutes: 30 });
    const a = { start: Date.UTC(2026, 7, 3, 6, 0), end: Date.UTC(2026, 7, 3, 6, 30) };
    const b = { start: Date.UTC(2026, 7, 3, 6, 30), end: Date.UTC(2026, 7, 3, 7, 0) };
    // Asymmetric buffers are exactly the case a one-sided rule gets wrong: it
    // would see the collision from b's side and miss it from a's.
    expect(bookingsConflict(a, b, p)).toBe(true);
    expect(bookingsConflict(b, a, p)).toBe(true);
    const far = { start: Date.UTC(2026, 7, 3, 8, 0), end: Date.UTC(2026, 7, 3, 8, 30) };
    expect(bookingsConflict(a, far, p)).toBe(false);
    expect(bookingsConflict(far, a, p)).toBe(false);
  });

  test("capacity counts down instead of closing the slot", () => {
    const at = Date.UTC(2026, 7, 3, 6, 0); // 09:00
    const slots = availableSlots({
      policy: policy({ capacity: 3 }),
      rules: [mondayMorning],
      busy: [
        { start: at, end: at + 30 * 60_000 },
        { start: at, end: at + 30 * 60_000 },
      ],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(slots[0]!.remaining).toBe(1);
    expect(slots[1]!.remaining).toBe(3);
  });

  test("a full slot is absent rather than present with zero left", () => {
    const at = Date.UTC(2026, 7, 3, 6, 0);
    const slots = availableSlots({
      policy: policy({ capacity: 1 }),
      rules: [mondayMorning],
      busy: [{ start: at, end: at + 30 * 60_000 }],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(slots.every((s) => s.remaining > 0)).toBe(true);
    expect(slots.map((s) => hhmm(s.start))).not.toContain("09:00");
  });

  test("lead time and horizon clamp the window", () => {
    const lead = availableSlots({
      policy: policy({ leadMinutes: 24 * 60 }),
      rules: [mondayMorning],
      busy: [],
      from: MONDAY,
      to: MONDAY + 14 * 86_400_000,
      // Standing on Monday morning, a day's notice rules out this Monday.
      now: Date.UTC(2026, 7, 3, 5, 0),
    });
    expect(lead).toHaveLength(4);
    expect(civilDateIn(lead[0]!.start, ISTANBUL).day).toBe(10);

    // Standing on the Tuesday, a three-day horizon does not reach the next
    // Monday. (`THE_WEEK_BEFORE` is itself a Monday, so the clock has to start
    // after it for the horizon to be the thing under test.)
    const horizon = availableSlots({
      policy: policy({ horizonDays: 3 }),
      rules: [mondayMorning],
      busy: [],
      from: THE_WEEK_BEFORE + 86_400_000,
      to: THE_WEEK_BEFORE + 30 * 86_400_000,
      now: THE_WEEK_BEFORE + 86_400_000,
    });
    expect(horizon).toHaveLength(0);
  });

  test("a step smaller than the slot produces overlapping offers", () => {
    const slots = availableSlots({
      policy: policy({ slotMinutes: 60, stepMinutes: 30 }),
      rules: [mondayMorning],
      busy: [],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(slots.map((s) => hhmm(s.start))).toEqual(["09:00", "09:30", "10:00"]);
  });

  test("no slot is offered at a local time that does not exist", () => {
    // Berlin, spring forward Sunday 2026-03-29, opening 01:00–05:00.
    const sunday: AvailabilityRule = {
      kind: "open",
      weekday: 0,
      startMinute: 60,
      endMinute: 5 * 60,
      startsOn: "2026-03-29",
      endsOn: "2026-03-29",
    };
    const slots = availableSlots({
      policy: policy({ timeZone: BERLIN, slotMinutes: 60 }),
      rules: [sunday],
      busy: [],
      from: Date.UTC(2026, 2, 28),
      to: Date.UTC(2026, 2, 30),
      now: Date.UTC(2026, 2, 28),
    });
    // 01:00 exists, 02:00 does not, 03:00 and 04:00 do.
    expect(slots.map((s) => hhmm(s.start, BERLIN))).toEqual(["01:00", "03:00", "04:00"]);
    // And the hour that spans the jump really is one hour of elapsed time.
    expect(slots[0]!.end - slots[0]!.start).toBe(3_600_000);
  });

  test("the walk is bounded no matter what window is asked for", () => {
    const slots = availableSlots({
      policy: policy({ horizonDays: 10_000 }),
      rules: [
        { kind: "open", weekday: null, startMinute: 0, endMinute: 1440, startsOn: null, endsOn: null },
      ],
      busy: [],
      from: MONDAY,
      to: MONDAY + 10_000 * 86_400_000,
      now: MONDAY,
    });
    expect(slots.length).toBeLessThanOrEqual(500);
  });
});

describe("slotIsOffered", () => {
  const args = (start: number, over: Partial<SlotPolicy> = {}) => ({
    policy: policy(over),
    rules: [mondayMorning],
    start,
    end: start + 30 * 60_000,
    now: MONDAY,
  });

  test("accepts an instant the listing would have produced", () => {
    expect(slotIsOffered(args(Date.UTC(2026, 7, 3, 6, 30)))).toEqual({ ok: true });
  });

  test("refuses a start that is inside the hours but off the grid", () => {
    expect(slotIsOffered(args(Date.UTC(2026, 7, 3, 6, 7)))).toEqual({
      ok: false,
      reason: "misaligned",
    });
  });

  test("refuses a start outside the published hours", () => {
    expect(slotIsOffered(args(Date.UTC(2026, 7, 3, 9, 0)))).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  test("refuses a duration the resource does not sell", () => {
    expect(
      slotIsOffered({
        ...args(Date.UTC(2026, 7, 3, 6, 0)),
        end: Date.UTC(2026, 7, 3, 8, 0),
      }),
    ).toEqual({ ok: false, reason: "misaligned" });
  });

  test("refuses the past, the notice period and beyond the horizon", () => {
    expect(slotIsOffered({ ...args(Date.UTC(2026, 6, 27, 6, 0)) }).ok).toBe(false);
    expect(
      slotIsOffered({ ...args(Date.UTC(2026, 7, 3, 6, 0), { leadMinutes: 24 * 60 }) }),
    ).toEqual({ ok: false, reason: "lead" });
    expect(
      slotIsOffered({ ...args(Date.UTC(2026, 7, 10, 6, 0), { horizonDays: 1 }) }),
    ).toEqual({ ok: false, reason: "horizon" });
  });

  test("the grid restarts after a block rather than running through it", () => {
    const block: AvailabilityRule = {
      kind: "block",
      weekday: 1,
      startMinute: 9 * 60 + 15,
      endMinute: 9 * 60 + 45,
      startsOn: null,
      endsOn: null,
    };
    // 09:45 is the first offer after the block, even though it is not on the
    // 09:00 half-hour grid.
    const offered = availableSlots({
      policy: policy(),
      rules: [mondayMorning, block],
      busy: [],
      from: MONDAY,
      to: MONDAY + 86_400_000,
      now: MONDAY,
    });
    expect(hhmm(offered[0]!.start)).toBe("09:45");
    expect(
      slotIsOffered({
        policy: policy(),
        rules: [mondayMorning, block],
        start: offered[0]!.start,
        end: offered[0]!.end,
        now: MONDAY,
      }),
    ).toEqual({ ok: true });
  });
});
