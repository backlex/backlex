import { z } from "zod";
import type { Condition } from "./permission";
import { type CivilDate, wallClockToUtc, zonedParts } from "./booking";

/**
 * Date-relative flow triggers — "three days before an invoice is due".
 *
 * Twenty of the twenty-six schema templates carry a deadline field, and until
 * this existed none of them could act on it: a flow trigger was `event`,
 * `manual` or `cron`, and a cron tick arrives with no row at all. So the shape
 * every one of those templates wanted — *for each row whose date is N days
 * away, do this* — was inexpressible.
 *
 * The whole spec is pure. Nothing here reads a clock, a database or an
 * environment; the caller passes `now` and the raw column values, which is what
 * makes the window arithmetic testable against DST rather than hopefully
 * correct.
 */

/** Units an offset may be expressed in. Days and weeks are calendar units when
 *  `at` is set; see {@link fireInstant}. */
export const ScheduleOffsetUnits = ["minutes", "hours", "days", "weeks"] as const;
export type ScheduleOffsetUnit = (typeof ScheduleOffsetUnits)[number];

/** Whether the offset lands before or after the field's own instant. Kept as a
 *  separate sign rather than a negative number so the admin can render two
 *  controls (a count and a direction) without parsing. */
export const ScheduleDirections = ["before", "after"] as const;
export type ScheduleDirection = (typeof ScheduleDirections)[number];

export interface ScheduleSpec {
  /** Collection slug whose rows are scanned. */
  collection: string;
  /** `timestamp` field the schedule is relative to. */
  field: string;
  /** How far from `field` the flow fires. */
  offset: {
    value: number;
    unit: ScheduleOffsetUnit;
    direction: ScheduleDirection;
  };
  /**
   * Minutes past local midnight to fire at, or null to keep the field's own
   * time of day.
   *
   * Set, the fire instant is computed in CIVIL space: the field's calendar date
   * in `timeZone`, shifted by whole days, at this wall clock. That is what
   * "three days before, at 09:00" means to a person, and it survives a DST
   * transition in between — a constant millisecond shift would land at 08:00 or
   * 10:00 for half the year.
   *
   * Requires a `days` or `weeks` offset: "two hours before, at 09:00" names two
   * different instants and there is no defensible way to pick one, so it is
   * refused at save time rather than silently resolved.
   */
  at: number | null;
  /** IANA zone the `at` wall clock is read in. Null → UTC. Ignored when `at`
   *  is null, because no wall clock is involved. */
  timeZone: string | null;
  /** Extra row filter, in the same condition DSL permissions use — so
   *  "…and it is still unpaid" compiles to SQL rather than being re-checked
   *  per row in JS. */
  where: Condition | null;
}

const ConditionPassthrough = z.custom<Condition>(
  (v) => v === null || (typeof v === "object" && v !== null),
);

export const ScheduleSpecSchema = z.object({
  collection: z.string().min(1).max(120),
  field: z.string().min(1).max(120),
  offset: z.object({
    // Zero is legitimate ("on the due date itself"); the cap keeps a typo from
    // producing a window the scan would never reach anyway.
    value: z.number().int().min(0).max(3650),
    unit: z.enum(ScheduleOffsetUnits),
    direction: z.enum(ScheduleDirections),
  }),
  at: z.number().int().min(0).max(1439).nullable(),
  timeZone: z.string().min(1).max(80).nullable(),
  where: ConditionPassthrough.nullable(),
});

/**
 * How far back a scan will reach for rows it has not fired yet.
 *
 * A tick window alone is not enough: `lastTickAt` is per-process state, and on
 * every serverless runtime each minute may run in a fresh instance where it is
 * null. A restart, a deploy or a cold gap would then drop every row whose
 * instant fell in the gap — silently, and for a deadline reminder that is the
 * one failure nobody notices until the deadline passes.
 *
 * So the scan looks back over this whole window and leans on the fire ledger
 * for exactly-once instead. Two days is long enough to cover any realistic
 * outage and short enough that the ledger stays prunable.
 */
export const SCHEDULE_CATCHUP_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Slop added to each end of the SQL pre-filter range when `at` is set.
 *
 * With a wall clock involved, the raw column value that produces a given fire
 * instant depends on the zone offset (±14h) and on whether a DST transition
 * sits in between. Rather than encode that in SQL, the range over-fetches by a
 * day either side and {@link fireInstant} decides exactly, per row, in JS. The
 * candidate set stays small because the range is still anchored on the offset.
 */
const CIVIL_SLOP_MS = 24 * 60 * 60 * 1000;

const MS_PER = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
} as const satisfies Record<ScheduleOffsetUnit, number>;

/** The offset as signed milliseconds. Only meaningful when `at` is null; with a
 *  wall clock the day shift is calendar arithmetic, not a constant. */
export const offsetMs = (offset: ScheduleSpec["offset"]): number =>
  (offset.direction === "before" ? -1 : 1) * offset.value * MS_PER[offset.unit];

/** The offset as signed whole days. Only meaningful when `at` is set, which
 *  {@link ScheduleSpecSchema} pairs with a `days`/`weeks` unit. */
const offsetDays = (offset: ScheduleSpec["offset"]): number => {
  const days = offset.unit === "weeks" ? offset.value * 7 : offset.value;
  return (offset.direction === "before" ? -1 : 1) * days;
};

/** Shift a civil date by whole days without going through a zone. Uses UTC
 *  midnight purely as a calendar, so no offset can leak in. */
const addDays = (date: CivilDate, days: number): CivilDate => {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/**
 * A raw column value → the UTC instant it names, or null if it names none.
 *
 * `timestamp` is the only date-bearing field type, but it arrives in three
 * shapes depending on dialect and driver: epoch milliseconds on SQLite, a
 * `Date` from the Postgres driver, and an ISO string from anything that has
 * already been serialized. A value that parses to nothing returns null rather
 * than `NaN`, so a malformed cell skips its row instead of poisoning the
 * comparison — `NaN` compares false against everything and would look exactly
 * like "not due yet", forever.
 */
export const toInstantMs = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // A bare integer string is epoch ms — SQLite columns read back as strings
    // through some drivers, and `Date.parse("1786000000000")` is NaN.
    if (/^-?\d+$/.test(trimmed)) {
      const ms = Number(trimmed);
      return Number.isFinite(ms) ? ms : null;
    }
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
};

/**
 * The exact instant a row fires, or null if it never does.
 *
 * Null means "skip this row", and it has two causes worth telling apart in the
 * caller's head: the field held nothing parseable, or the wall clock the spec
 * asks for does not exist on that day (the spring-forward gap). Both are
 * legitimately unfireable, and neither should be rounded into a neighbouring
 * hour — a reminder that claims 02:30 and arrives at 03:30 misinformed the
 * person reading it.
 */
export const fireInstant = (
  fieldValue: unknown,
  spec: Pick<ScheduleSpec, "offset" | "at" | "timeZone">,
): number | null => {
  const base = toInstantMs(fieldValue);
  if (base === null) return null;
  if (spec.at === null) return base + offsetMs(spec.offset);

  const zone = spec.timeZone ?? "UTC";
  const parts = zonedParts(base, zone);
  const shifted = addDays(
    { year: parts.year, month: parts.month, day: parts.day },
    offsetDays(spec.offset),
  );
  const result = wallClockToUtc(shifted, spec.at, zone);
  return result.exists ? result.utcMs : null;
};

/**
 * The raw-column range worth pulling out of SQL for a scan covering
 * `(fromMs, toMs]`.
 *
 * Exact when `at` is null: the fire instant is the column plus a constant, so
 * the window inverts cleanly. Deliberately loose when a wall clock is involved
 * — see {@link CIVIL_SLOP_MS}. Either way this is a pre-filter, never the
 * decision: {@link fireInstant} re-checks every candidate.
 */
export const scanRange = (
  spec: Pick<ScheduleSpec, "offset" | "at">,
  fromMs: number,
  toMs: number,
): { minMs: number; maxMs: number } => {
  if (spec.at === null) {
    const shift = offsetMs(spec.offset);
    return { minMs: fromMs - shift, maxMs: toMs - shift };
  }
  const shift = offsetDays(spec.offset) * 86_400_000;
  return {
    minMs: fromMs - shift - CIVIL_SLOP_MS,
    maxMs: toMs - shift + CIVIL_SLOP_MS,
  };
};

/** True when a computed fire instant lands inside the half-open scan window.
 *  Half-open on purpose: adjacent windows must not both claim an instant, and
 *  the ledger should be a backstop rather than the only thing preventing a
 *  double send. */
export const firesWithin = (
  instantMs: number | null,
  fromMs: number,
  toMs: number,
): boolean => instantMs !== null && instantMs > fromMs && instantMs <= toMs;

const TRIGGER_PREFIX = "schedule:";

/** Serialize a spec into the `flows.trigger` column. JSON rather than a
 *  colon-delimited string because the spec carries a nested condition; the
 *  column stays the single source of a flow's trigger, as it is for
 *  `event:` and `cron:`. */
export const formatScheduleTrigger = (spec: ScheduleSpec): string =>
  `${TRIGGER_PREFIX}${JSON.stringify(spec)}`;

/**
 * Parse a `flows.trigger` value into a spec, or null if it is not a schedule
 * trigger or does not validate.
 *
 * Null on a malformed spec rather than a throw: this runs inside the scheduler
 * tick over every flow in the instance, and one bad row must not stop the
 * others from firing. The caller logs it.
 */
export const parseScheduleTrigger = (trigger: string): ScheduleSpec | null => {
  if (!trigger.startsWith(TRIGGER_PREFIX)) return null;
  const raw = trigger.slice(TRIGGER_PREFIX.length).trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ScheduleSpecSchema.safeParse(parsed);
  return result.success ? (result.data as ScheduleSpec) : null;
};

/**
 * Why a spec cannot be saved, or null if it is fine.
 *
 * Only the internally-checkable rules live here — whether the named field
 * exists and is a `timestamp` needs the collection, so the route checks that
 * against the loaded schema. Returns a sentence rather than a code because it
 * is shown to whoever is editing the flow.
 */
export const validateScheduleSpec = (spec: ScheduleSpec): string | null => {
  if (spec.at !== null && spec.offset.unit !== "days" && spec.offset.unit !== "weeks") {
    return "A time of day can only be paired with a day or week offset — \"2 hours before, at 09:00\" names two different instants.";
  }
  if (spec.at !== null && spec.timeZone) {
    try {
      // Intl is the authority on which zones exist; an unknown one throws here
      // rather than silently resolving to UTC at run time, which would fire
      // every reminder at the wrong hour with nothing to point at.
      new Intl.DateTimeFormat("en-US", { timeZone: spec.timeZone });
    } catch {
      return `Unknown time zone "${spec.timeZone}".`;
    }
  }
  return null;
};
