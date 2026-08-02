/**
 * Availability → bookable slots.
 *
 * Ten of the twenty-six schema templates carry a time-slot shape — the
 * `appointments` template goes as far as modelling `availability_rules` and
 * `bookings` itself — and none of them could say when a resource is actually
 * free. Storing a booking was never the missing piece; a collection already
 * does that. The missing piece is this function: an opening pattern expressed
 * in somebody's local week, minus the exceptions, minus what is already taken,
 * turned into a list of instants a stranger can pick from.
 *
 * Pure and dependency-free — no clock, no db, no env. `now` is a parameter, so
 * a test can stand on any Tuesday it likes and the same input always yields the
 * same slots.
 *
 * Three things this module is deliberate about:
 *
 * 1. **Rules are LOCAL, slots are UTC.** "Mondays 09:00–17:00" does not move
 *    when the clocks do; the instant it starts at does. Every rule is stored as
 *    a weekday plus minutes-from-local-midnight and only ever becomes a UTC
 *    instant here, against the resource's own zone.
 * 2. **A local time that does not exist yields no slot.** On the morning the
 *    clocks go forward, 02:30 is not a late start — it is not a time. Rather
 *    than silently booking 03:30 for somebody who read 02:30, {@link wallClockToUtc}
 *    reports the gap and the slot is dropped. (The ambiguous hour in autumn is
 *    the mirror case: two instants share one wall clock and the EARLIER one is
 *    what gets offered.)
 * 3. **Every booking carries its own buffers, including the one being
 *    considered.** `bufferBefore` and `bufferAfter` are different activities —
 *    preparing and clearing up — so both have to fit between two consecutive
 *    bookings: 15 either side means a 30-minute gap, not a 15-minute one.
 *    Charging the buffer only to the side that already exists would be cheaper
 *    and also ASYMMETRIC, so whether two bookings conflict would depend on
 *    which was entered first — precisely the property the write-path guard
 *    cannot have, since two racers must reach the same verdict. An operator who
 *    wants a one-sided gap sets one side.
 */

/** `0` = Sunday … `6` = Saturday, matching `Date#getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Minutes from local midnight. `1440` is the end of the day, not the start of
 *  the next one — a shift that crosses midnight is two rules, so that no
 *  interval has to be read as "wraps around". */
export const MINUTES_PER_DAY = 1440;

export interface AvailabilityRule {
  /**
   * `open` adds bookable time; `block` takes it away. Blocks always win, and
   * they are applied after every open rule has been merged — a holiday declared
   * once must not have to be subtracted from each opening pattern separately.
   */
  kind: "open" | "block";
  /**
   * Which day of the week this repeats on, or `null` for "every day inside the
   * date range" — which is how a one-off closure is expressed: a `block` with
   * no weekday, `startsOn`/`endsOn` covering the dates and `0`–`1440` covering
   * the day.
   */
  weekday: Weekday | null;
  /** Inclusive. */
  startMinute: number;
  /** Exclusive. */
  endMinute: number;
  /** `YYYY-MM-DD` in the resource's zone, inclusive. `null` = unbounded. */
  startsOn: string | null;
  endsOn: string | null;
}

/** A UTC half-open interval `[start, end)` in epoch milliseconds. */
export interface BusyInterval {
  start: number;
  end: number;
}

export interface SlotPolicy {
  /** IANA zone the rules are written in. */
  timeZone: string;
  /** How long one booking lasts. */
  slotMinutes: number;
  /**
   * Distance between two consecutive slot STARTS. Defaults to `slotMinutes`
   * (back-to-back). A smaller step gives overlapping offers — 30-minute
   * viewings every 15 minutes — which is legitimate for a resource whose
   * capacity is greater than one.
   */
  stepMinutes?: number;
  /** How many bookings one instant holds. `1` for a dentist, `12` for a class. */
  capacity: number;
  /** Dead time protected before and after each EXISTING booking. */
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Minimum notice. A slot starting sooner than this is not offered. */
  leadMinutes: number;
  /** How far ahead the calendar is open at all. */
  horizonDays: number;
}

export interface Slot {
  /** UTC epoch ms. */
  start: number;
  end: number;
  /** Capacity left at this instant — `1` on a one-at-a-time resource, and the
   *  seats remaining on a class. Never `0`: a full slot is not returned. */
  remaining: number;
}

/**
 * Ceiling on how many slots one query may produce, and how many days it may
 * walk. Both exist because `from`/`to` arrive from a public, unauthenticated
 * endpoint: a request for the year 3000 must cost a bounded amount of work
 * rather than a bounded amount of patience.
 */
export const MAX_SLOTS = 500;
export const MAX_RANGE_DAYS = 62;

/* ───────────────────────────── zone arithmetic ───────────────────────────── */

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
};

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock a UTC instant shows in `timeZone`. */
export const zonedParts = (utcMs: number, timeZone: string): ZonedParts => {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
};

/**
 * `timeZone`'s offset from UTC at a given instant, in milliseconds.
 *
 * Derived by formatting the instant into the zone and re-reading those digits
 * as if they were UTC. That difference IS the offset, and it needs no table of
 * transition dates — the runtime's own Intl data is the authority, including
 * for the zones that have changed their rules since this was written.
 */
export const zoneOffsetMs = (utcMs: number, timeZone: string): number => {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const p = zonedParts(whole, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
};

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export interface WallClockResult {
  /** The UTC instant the wall clock names. Best-effort when `exists` is false —
   *  the caller is expected to discard it, not to round it. */
  utcMs: number;
  /**
   * False when the requested local time falls in a spring-forward gap. The
   * caller must drop the slot rather than round it: somebody who read "02:30"
   * and arrives to find they booked 03:30 was misled by us, not by the clock.
   */
  exists: boolean;
}

/**
 * A local wall clock → the UTC instant it names.
 *
 * The offset cannot be looked up before the instant is known and the instant
 * cannot be computed before the offset is. Rather than guess and correct — which
 * silently lands on the SECOND reading of an ambiguous hour — this builds both
 * candidates from the offsets in force a day either side, then keeps only the
 * ones that format back to the wall clock that was asked for:
 *
 * - **Two survive** on the autumn morning an hour is repeated. The earlier is
 *   returned, matching what every calendar does with a doubled hour.
 * - **One survives** on every ordinary day.
 * - **None survive** in a spring-forward gap, which is the whole point: the
 *   time does not exist and `exists` says so.
 */
export const wallClockToUtc = (
  date: CivilDate,
  minuteOfDay: number,
  timeZone: string,
): WallClockResult => {
  const naive = Date.UTC(date.year, date.month - 1, date.day) + minuteOfDay * 60_000;
  const wanted = addMinutes(date, minuteOfDay);
  const roundTrips = (utcMs: number): boolean => {
    const back = zonedParts(utcMs, timeZone);
    return (
      back.year === wanted.date.year &&
      back.month === wanted.date.month &&
      back.day === wanted.date.day &&
      back.hour * 60 + back.minute === wanted.minute
    );
  };

  // A day either side is always far enough: no zone transitions twice within
  // 24 hours, so these two offsets bracket every offset the wall clock could
  // have been written under.
  const before = zoneOffsetMs(naive - 86_400_000, timeZone);
  const after = zoneOffsetMs(naive + 86_400_000, timeZone);
  const candidates = before === after ? [naive - before] : [naive - before, naive - after];
  const valid = candidates.filter(roundTrips).sort((a, b) => a - b);
  const first = valid[0];
  if (first !== undefined) return { utcMs: first, exists: true };

  // The gap. `naive - before` is the pre-transition offset, which reads as the
  // hour AFTER the requested one — the same direction a clock jumps — so it is
  // the least surprising thing to hand back to a caller that ignores `exists`.
  return { utcMs: naive - before, exists: false };
};

/** Roll a civil date + minute-of-day into a normalised (date, minute) pair.
 *  Only used to state what {@link wallClockToUtc} was asked for, so the
 *  round-trip comparison is against a normalised value — `1440` on the 3rd is
 *  `0` on the 4th. */
const addMinutes = (
  date: CivilDate,
  minuteOfDay: number,
): { date: CivilDate; minute: number } => {
  const dayShift = Math.floor(minuteOfDay / MINUTES_PER_DAY);
  const minute = minuteOfDay - dayShift * MINUTES_PER_DAY;
  if (dayShift === 0) return { date, minute };
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + dayShift));
  return {
    date: {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    },
    minute,
  };
};

/** `YYYY-MM-DD`. ISO date strings compare correctly as plain strings, which is
 *  the whole reason rule bounds are stored in this shape. */
export const dateKey = (date: CivilDate): string =>
  `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

/** The civil date an instant falls on, in `timeZone`. */
export const civilDateIn = (utcMs: number, timeZone: string): CivilDate => {
  const p = zonedParts(utcMs, timeZone);
  return { year: p.year, month: p.month, day: p.day };
};

/** The next calendar day. Pure civil arithmetic — it never touches a zone, so
 *  a transition day is one day like any other. */
export const nextDay = (date: CivilDate): CivilDate => {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/** Day of week for a civil date, DST-free by construction. */
export const weekdayOf = (date: CivilDate): Weekday =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() as Weekday;

/* ───────────────────────────── interval algebra ──────────────────────────── */

interface Interval {
  start: number;
  end: number;
}

const merge = (intervals: Interval[]): Interval[] => {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
};

/** `base` minus every interval in `cuts`. Both are assumed merged. */
const subtract = (base: Interval[], cuts: Interval[]): Interval[] => {
  if (cuts.length === 0) return base;
  let out = base;
  for (const cut of cuts) {
    const next: Interval[] = [];
    for (const span of out) {
      if (cut.end <= span.start || cut.start >= span.end) {
        next.push(span);
        continue;
      }
      if (cut.start > span.start) next.push({ start: span.start, end: cut.start });
      if (cut.end < span.end) next.push({ start: cut.end, end: span.end });
    }
    out = next;
  }
  return out;
};

const appliesOn = (rule: AvailabilityRule, date: CivilDate): boolean => {
  if (rule.weekday !== null && rule.weekday !== weekdayOf(date)) return false;
  const key = dateKey(date);
  if (rule.startsOn && key < rule.startsOn) return false;
  if (rule.endsOn && key > rule.endsOn) return false;
  return true;
};

/* ────────────────────────────── the conflict rule ───────────────────────── */

/**
 * Do two bookings on one resource collide?
 *
 * Exported because the write path MUST decide this the same way the listing
 * did. Two separate implementations of "overlaps" is how a slot comes to be
 * offered and then refused — and, worse, how two racing writers reach opposite
 * verdicts about each other and both survive. Everything that asks the question
 * asks it here.
 *
 * Both sides are expanded by the buffers, which is what makes the relation
 * symmetric: `conflicts(a, b)` and `conflicts(b, a)` are the same expression.
 */
export const bookingsConflict = (
  a: BusyInterval,
  b: BusyInterval,
  policy: Pick<SlotPolicy, "bufferBeforeMinutes" | "bufferAfterMinutes">,
): boolean => {
  const before = policy.bufferBeforeMinutes * 60_000;
  const after = policy.bufferAfterMinutes * 60_000;
  return a.start - before < b.end + after && a.end + after > b.start - before;
};

/** How many of `guarded` (already expanded) a raw candidate collides with. */
const countConflicts = (
  guarded: Interval[],
  start: number,
  end: number,
  policy: Pick<SlotPolicy, "bufferBeforeMinutes" | "bufferAfterMinutes">,
): number => {
  const before = policy.bufferBeforeMinutes * 60_000;
  const after = policy.bufferAfterMinutes * 60_000;
  const lo = start - before;
  const hi = end + after;
  let n = 0;
  for (const g of guarded) {
    if (lo < g.end && hi > g.start) n++;
  }
  return n;
};

/* ─────────────────────────────── the query ──────────────────────────────── */

export interface SlotQuery {
  policy: SlotPolicy;
  rules: AvailabilityRule[];
  /** Everything already occupying the resource, in UTC. Held bookings whose
   *  hold has lapsed must be filtered out BEFORE they get here — this function
   *  has no clock of its own beyond `now`. */
  busy: BusyInterval[];
  /** UTC window the caller is asking about. */
  from: number;
  to: number;
  now: number;
}

/**
 * Every slot a resource can still take between `from` and `to`.
 *
 * The walk is per LOCAL day rather than per UTC day, because a rule is written
 * in local days: on the far side of the date line the two disagree by a full
 * day, and around a transition they disagree by an hour. One extra day is
 * walked at each end so a local day that straddles `from`/`to` still
 * contributes its slots.
 */
export const availableSlots = (query: SlotQuery): Slot[] => {
  const { policy, rules, busy, from, to, now } = query;
  const step = policy.stepMinutes && policy.stepMinutes > 0 ? policy.stepMinutes : policy.slotMinutes;
  if (policy.slotMinutes <= 0 || policy.capacity <= 0) return [];

  // Clamp the window before anything is walked. `earliest`/`latest` fold the
  // lead time and the horizon in here rather than filtering at the end, so a
  // request for next year does no work instead of doing it and discarding it.
  const earliest = Math.max(from, now + policy.leadMinutes * 60_000);
  const latest = Math.min(to, now + policy.horizonDays * 86_400_000);
  if (!(earliest < latest)) return [];

  const tz = policy.timeZone;
  const opens = rules.filter((r) => r.kind === "open");
  const blocks = rules.filter((r) => r.kind === "block");

  // Every booking's protected region — the slot itself plus the time either
  // side that the operator reserved around it. The candidate is expanded the
  // same way below, so the test is symmetric and two consecutive bookings must
  // leave room for both buffers.
  const guarded = busy.map((b) => ({
    start: b.start - policy.bufferBeforeMinutes * 60_000,
    end: b.end + policy.bufferAfterMinutes * 60_000,
  }));

  const slots: Slot[] = [];
  // The first local day is the one `earliest` itself falls on. A day that began
  // before the window still contributes — its later slots are on this same
  // local date — and the ones that began too early are dropped by the `start <
  // earliest` test below rather than by skipping the day.
  let date = civilDateIn(earliest, tz);
  const lastDate = dateKey(civilDateIn(latest, tz));
  let walked = 0;

  // eslint-disable-next-line no-constant-condition
  while (walked <= MAX_RANGE_DAYS + 1) {
    const key = dateKey(date);
    if (key > lastDate) break;
    walked++;

    const openSpans = merge(
      opens.filter((r) => appliesOn(r, date)).map((r) => ({ start: r.startMinute, end: r.endMinute })),
    );
    if (openSpans.length > 0) {
      const blockSpans = merge(
        blocks.filter((r) => appliesOn(r, date)).map((r) => ({ start: r.startMinute, end: r.endMinute })),
      );
      const free = subtract(openSpans, blockSpans);

      for (const span of free) {
        for (let m = span.start; m + policy.slotMinutes <= span.end; m += step) {
          const startAt = wallClockToUtc(date, m, tz);
          // A start inside a spring-forward gap is not a start at all.
          if (!startAt.exists) continue;
          const endAt = wallClockToUtc(date, m + policy.slotMinutes, tz);
          const start = startAt.utcMs;
          // The END may legitimately land in a gap (a 60-minute slot beginning
          // at 01:30 on transition morning ends at a 02:30 that never happens),
          // and unlike the start that is not misleading — the appointment
          // simply runs for the wall-clock hour the operator published. Fall
          // back to elapsed time so the interval is never inverted.
          const end = endAt.exists ? endAt.utcMs : start + policy.slotMinutes * 60_000;
          if (end <= start) continue;
          if (start < earliest || start >= latest) continue;

          const remaining = policy.capacity - countConflicts(guarded, start, end, policy);
          if (remaining <= 0) continue;

          slots.push({ start, end, remaining });
          if (slots.length >= MAX_SLOTS) return slots.sort((a, b) => a.start - b.start);
        }
      }
    }
    date = nextDay(date);
  }

  return slots.sort((a, b) => a.start - b.start);
};

/**
 * Whether one specific interval is still takeable — the question `availableSlots`
 * answers in bulk, asked about a single instant.
 *
 * The booking path needs this separately because it must NOT re-derive the slot
 * list to check one of them: the caller names a start that came from an earlier
 * listing, and between the two the world moved. It is also the cheaper half —
 * no walk, one interval.
 */
export const slotIsOffered = (args: {
  policy: SlotPolicy;
  rules: AvailabilityRule[];
  start: number;
  end: number;
  now: number;
}): { ok: true } | { ok: false; reason: "past" | "lead" | "horizon" | "closed" | "misaligned" } => {
  const { policy, rules, start, end, now } = args;
  if (end <= start) return { ok: false, reason: "misaligned" };
  if (start < now) return { ok: false, reason: "past" };
  if (start < now + policy.leadMinutes * 60_000) return { ok: false, reason: "lead" };
  if (start > now + policy.horizonDays * 86_400_000) return { ok: false, reason: "horizon" };
  if (Math.round((end - start) / 60_000) !== policy.slotMinutes) {
    return { ok: false, reason: "misaligned" };
  }

  const tz = policy.timeZone;
  // A slot may only be checked against the local day it STARTS on: that is the
  // day whose rules published it.
  const date = civilDateIn(start, tz);
  const p = zonedParts(start, tz);
  const startMinute = p.hour * 60 + p.minute;
  const endMinute = startMinute + policy.slotMinutes;

  const openSpans = merge(
    rules
      .filter((r) => r.kind === "open" && appliesOn(r, date))
      .map((r) => ({ start: r.startMinute, end: r.endMinute })),
  );
  const blockSpans = merge(
    rules
      .filter((r) => r.kind === "block" && appliesOn(r, date))
      .map((r) => ({ start: r.startMinute, end: r.endMinute })),
  );
  const free = subtract(openSpans, blockSpans);
  const holder = free.find((s) => startMinute >= s.start && endMinute <= s.end);
  if (!holder) return { ok: false, reason: "closed" };

  // Alignment is measured from the span that actually contains the slot — the
  // grid restarts after every block, so the offsets of an earlier span say
  // nothing about this one. Without this test a caller could name 09:07 on a
  // resource that publishes 09:00 and 09:30: inside the opening hours, but not
  // a slot anybody was offered, and enough of them would shred the day into
  // unbookable gaps.
  const step = policy.stepMinutes && policy.stepMinutes > 0 ? policy.stepMinutes : policy.slotMinutes;
  if ((startMinute - holder.start) % step !== 0) return { ok: false, reason: "misaligned" };

  return { ok: true };
};
