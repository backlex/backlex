import type { Condition, ScheduleSpec } from "@backlex/core";
import { parseScheduleTrigger } from "@backlex/core";

/**
 * A saved flow's `trigger` column, taken apart for display.
 *
 * The column is a machine key — `event:items:posts:created`, `cron:0 3 * * *`,
 * `schedule:{…}` — and the flows page used to print it verbatim. For a date
 * schedule that is the whole JSON spec, which wrapped a character at a time
 * inside the 176px preview node and ran under the list's status badge. This
 * returns the parts a person reads. The words are left to the page, so nothing
 * here touches Lingui and the parsing is testable as plain data.
 *
 * The read follows what the runtime matches on, not what the builder can emit:
 * a flow written through the API may carry `manual`, a bare channel, or an
 * event the builder has no palette entry for, and each of those still gets a
 * shape rather than falling through to the raw key.
 */
export type TriggerView =
  /** `event:items:<slug>:<event>`. A null collection is `*`; a null event is
   *  a channel-only key, which matches every write to the collection. */
  | { kind: "item"; event: ItemEvent | null; collection: string | null }
  /** `event:items:<slug>:transition:<field>:<from>:<to>` — a lifecycle move
   *  (docs/status-transitions.md). Each trailing segment may be absent or `*`,
   *  and both read as null: "any". */
  | { kind: "transition"; collection: string | null; field: string | null; from: string | null; to: string | null }
  /** `cadence` is null when the pattern is valid cron but not one of the
   *  shapes {@link cronCadence} can say in words. */
  | { kind: "cron"; pattern: string; cadence: CronCadence | null }
  | { kind: "schedule"; spec: ScheduleSpec; filters: number }
  | { kind: "webhook" }
  | { kind: "signup" }
  | { kind: "manual" }
  | { kind: "event"; key: string }
  | { kind: "unknown"; raw: string };

export type ItemEvent = "created" | "updated" | "deleted";
const ITEM_EVENTS: ReadonlySet<string> = new Set<ItemEvent>(["created", "updated", "deleted"]);

export const readTrigger = (trigger: string): TriggerView => {
  const raw = trigger.trim();
  if (raw.startsWith("cron:")) {
    const pattern = raw.slice("cron:".length).trim();
    return { kind: "cron", pattern, cadence: cronCadence(pattern) };
  }
  if (raw.startsWith("schedule:")) {
    const spec = parseScheduleTrigger(raw);
    // A spec that no longer validates is skipped by the scheduler, so it must
    // not borrow a label that says it runs.
    return spec ? { kind: "schedule", spec, filters: countFilters(spec.where) } : { kind: "unknown", raw };
  }
  if (raw === "webhook" || raw.startsWith("webhook:")) return { kind: "webhook" };
  if (raw === "manual" || raw.startsWith("manual:")) return { kind: "manual" };

  // The runtime reads an unprefixed key exactly like an `event:` one.
  const key = raw.startsWith("event:") ? raw.slice("event:".length) : raw;
  if (!key) return { kind: "unknown", raw };
  if (key === "auth:signup") return { kind: "signup" };
  const [channel, slug, event, ...rest] = key.split(":");
  if (channel === "items") {
    const any = (segment: string | undefined) => (segment && segment !== "*" ? segment : null);
    const collection = any(slug);
    if (rest.length === 0) {
      if (event === undefined || event === "*") return { kind: "item", event: null, collection };
      if (ITEM_EVENTS.has(event)) return { kind: "item", event: event as ItemEvent, collection };
    }
    if (event === "transition" && rest.length <= 3) {
      return { kind: "transition", collection, field: any(rest[0]), from: any(rest[1]), to: any(rest[2]) };
    }
  }
  return { kind: "event", key };
};

/**
 * How many field comparisons a condition holds.
 *
 * Counted per field rather than per object: `{ state, status }` is two, and an
 * `$and`/`$or` contributes its members, so the figure reads the same however
 * the filter happens to be nested. A range on one field (`_gte` + `_lte`) is
 * one — it constrains one thing.
 */
export const countFilters = (condition: Condition | null | undefined): number => {
  if (!condition || typeof condition !== "object") return 0;
  let n = 0;
  for (const [key, value] of Object.entries(condition)) {
    if ((key === "$and" || key === "$or") && Array.isArray(value)) {
      for (const member of value) n += countFilters(member as Condition);
    } else if (key === "$not") {
      n += countFilters(value as Condition);
    } else {
      n += 1;
    }
  }
  return n;
};

/**
 * The cron shapes that have a plain reading. Anything else — a month field, a
 * list of hours, a step that does not divide its cycle — returns null from
 * {@link cronCadence} and is shown as the pattern itself.
 *
 * Days of the week are 0–6 from Sunday, ordered Monday first.
 */
export type CronCadence =
  | { every: "minute"; step: number }
  | { every: "hour"; step: number; minute: number }
  | { every: "day"; hour: number; minute: number }
  | { every: "weekdays"; hour: number; minute: number }
  | { every: "week"; days: number[]; hour: number; minute: number }
  | { every: "month"; day: number; hour: number; minute: number };

const int = (field: string, min: number, max: number): number | null => {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
};

/**
 * `*` → 1 and `*\/n` → n, but only when n divides the cycle. `*\/7` in the
 * minute field fires at :56 and then again at :00, so "every 7 minutes" would
 * be wrong once an hour — that pattern stays a pattern.
 */
const step = (field: string, cycle: number): number | null => {
  if (field === "*") return 1;
  const m = /^\*\/(\d{1,2})$/.exec(field);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n < cycle && cycle % n === 0 ? n : null;
};

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** One day-of-week token as cron reads it: a name, or 0–7 with 7 as Sunday. */
const dayToken = (token: string): number | null => {
  const named = DAY_NAMES.indexOf(token.toLowerCase());
  return named >= 0 ? named : int(token, 0, 7);
};

const daysOfWeek = (field: string): number[] | null => {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const bounds = part.split("-");
    if (bounds.length > 2) return null;
    const from = dayToken(bounds[0]!);
    const to = bounds.length === 2 ? dayToken(bounds[1]!) : from;
    if (from === null || to === null || from > to) return null;
    for (let d = from; d <= to; d++) days.add(d % 7);
  }
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
};

/** A five-field cron pattern → a cadence a sentence can be built from. */
export const cronCadence = (pattern: string): CronCadence | null => {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string];
  if (monthField !== "*") return null;

  const hourStep = step(hourField, 24);
  if (hourStep !== null) {
    if (dayField !== "*" || weekdayField !== "*") return null;
    if (hourField === "*") {
      const minuteStep = step(minuteField, 60);
      if (minuteStep !== null) return { every: "minute", step: minuteStep };
    }
    const minute = int(minuteField, 0, 59);
    return minute === null ? null : { every: "hour", step: hourStep, minute };
  }

  const minute = int(minuteField, 0, 59);
  const hour = int(hourField, 0, 23);
  if (minute === null || hour === null) return null;
  if (dayField === "*") {
    if (weekdayField === "*") return { every: "day", hour, minute };
    const days = daysOfWeek(weekdayField);
    if (!days) return null;
    if (days.length === 7) return { every: "day", hour, minute };
    if (days.length === 5 && days.every((d) => d >= 1 && d <= 5)) return { every: "weekdays", hour, minute };
    return { every: "week", days, hour, minute };
  }
  if (weekdayField !== "*") return null;
  const day = int(dayField, 1, 31);
  return day === null ? null : { every: "month", day, hour, minute };
};
