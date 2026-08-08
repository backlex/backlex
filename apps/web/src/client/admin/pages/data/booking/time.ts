
import {
  type ApiBooking,
} from "../../../api";

export const WEEKDAYS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

/**
 * The weekday's own short name, in the reader's language.
 *
 * 2024-01-07 was a Sunday, so adding the weekday number lands on that weekday —
 * any week would do, this one just makes the arithmetic obvious. Intl rather
 * than a table because these are read at a glance on a row of chips, and a
 * Turkish operator reading "Mon" is being made to translate.
 */
export const shortWeekday = (weekday: number): string => {
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2024, 0, 7 + weekday)),
    );
  } catch {
    return String(weekday);
  }
};

/** The day sets "add rule" offers. A calendar is almost never one weekday, and
 *  adding Monday-to-Friday one row at a time is five times the work for the
 *  most ordinary answer there is. */
export const DAY_SETS = {
  one: [1],
  weekdays: [1, 2, 3, 4, 5],
  weekend: [6, 0],
  all: [0, 1, 2, 3, 4, 5, 6],
} as const;

export type DaySet = keyof typeof DAY_SETS;

/**
 * A short list of zones, plus whatever the browser is in.
 *
 * A finite set of values belongs in a dropdown rather than a text field, and
 * this one has a genuine "Custom…" case — `Intl` knows several hundred names
 * and an operator abroad will want one that is not on any short list.
 */
export const COMMON_ZONES = [
  "UTC",
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Today on the RESOURCE's wall calendar, as YYYY-MM-DD. A dated rule has to
 *  start somewhere, and the operator's own browser can already be on tomorrow
 *  — or still on yesterday — relative to the calendar being edited. */
export const todayIn = (timeZone: string): string => {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const ymd = `${get("year")}-${get("month")}-${get("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  } catch {
    // An unknown zone falls through to the reader's own calendar below.
  }
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** Instants come back in UTC; an operator reads them in the RESOURCE's zone,
 *  because a list of times for a clinic abroad read in the browser's zone is
 *  wrong on every line. */
export const inZone = (iso: string, timeZone: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
};

/** The same instant with the year dropped — a stat tile is a quarter of a row
 *  wide, and a year is the one part of "next free" nobody is reading. */
export const shortInZone = (iso: string, timeZone: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return inZone(iso, "UTC");
  }
};

/** Both ends of one booking, in the resource's zone, without repeating the day. */
export const rangeInZone = (start: string, end: string, timeZone: string): string => {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "—";
  try {
    const day = new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: "medium" }).format(a);
    const clock = new Intl.DateTimeFormat(undefined, { timeZone, timeStyle: "short" });
    return `${day} · ${clock.format(a)} – ${clock.format(b)}`;
  } catch {
    return inZone(start, "UTC");
  }
};

/** A booking can only be a no-show once its slot has actually passed — before
 *  that nobody has failed to turn up yet. The server agrees: it takes the
 *  STORED status, which stays `confirmed` while the derived one reads
 *  `completed`. */
export const isOver = (b: ApiBooking, now: number): boolean => Date.parse(b.end) <= now;

/**
 * The window the list is read through. An operator's first question is "who is
 * coming", not "what came in last", so upcoming-ascending is the default — and
 * it asks for `live`, because someone who cancelled is not coming. Narrowing to
 * a cancelled booking on purpose is what the status filter is for, and an
 * explicit status wins over this.
 */
export const WINDOWS = {
  upcoming: {
    order: "asc" as const,
    live: true,
    from: () => new Date().toISOString(),
    to: () => undefined,
  },
  past: {
    order: "desc" as const,
    live: false,
    from: () => undefined,
    to: () => new Date().toISOString(),
  },
  all: { order: "desc" as const, live: false, from: () => undefined, to: () => undefined },
};

export type WindowKey = keyof typeof WINDOWS;

/** Seven days out — far enough to read as a plan, near enough to be accurate. */
export const HORIZON_DAYS = 7;
