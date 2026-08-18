/**
 * Tag manager — the trigger vocabulary and the condition grammar.
 *
 * ── What this file is, and what it is not ─────────────────────────────────
 * A trigger condition is operator-authored JSON that decides whether a tag
 * fires. It is close kin to `analytics-segments.ts` and copies two things from
 * it deliberately — the closed field allowlist, and the caps — but **not its
 * security argument**, because the two compile to different places.
 *
 * A segment becomes SQL, so its whole defence is "field names are never
 * interpolated, values are always bound". Nothing here reaches a database. A
 * condition becomes a JSON tree that a fixed interpreter walks **in the
 * visitor's browser**, so the risks are different ones:
 *
 *  - **Unbounded work on someone else's page.** Every visitor to a customer's
 *    site evaluates this on every trigger. Hence `MAX_NODES` / `MAX_DEPTH` /
 *    `MAX_IN_VALUES`, which here bound a phone's main thread rather than a
 *    query planner.
 *  - **Catastrophic backtracking.** `matchesRegex` exists because GTM parity
 *    genuinely needs it — "page path matches RegEx" is one of the most-used
 *    triggers there is. What it does NOT get is a clever server-side filter
 *    for dangerous patterns: catastrophic backtracking has many shapes beyond
 *    the textbook `(a+)+`, and a filter that catches one shape mainly buys
 *    false confidence. The honest containment is smaller and true: cap the
 *    pattern length, compile it in a `try/catch`, and match **only in the
 *    browser** — so a pathological pattern hangs one visitor's tab instead of
 *    a Worker isolate. Say so in the docs rather than implying a proof.
 *  - **A stored blob that stopped being valid.** Same rule as a segment: the
 *    definition is re-parsed on every read, never trusted from storage. An
 *    invalid stored condition must fail closed — the tag does not fire — which
 *    is why `parseTagCondition` throws rather than returning a partial tree. A
 *    half-parsed condition would fire a marketing tag somewhere its author
 *    said it should not, and that is the failure with a regulator attached.
 *
 * ── A note on precedent ───────────────────────────────────────────────────
 * This repo has already refused expressiveness once on a neighbouring surface:
 * the collect route's `pathExcluded` supports exactly a leading and a trailing
 * `*`, with the reason written in — "a full glob engine here would be a parser
 * accepting untrusted input for no additional expressiveness anyone asked
 * for". Regex on a trigger is a different trade (GTM users reach for it by
 * habit, and the evaluation happens on the visitor's machine, not ours), but
 * the departure is deliberate rather than accidental.
 */
import { AppError } from "@backlex/core";

/**
 * Every kind of trigger the runtime knows how to arm.
 *
 * Closed by construction: adding one is an edit here AND a branch in the
 * browser runtime, and a test asserts the two lists agree. A type with no
 * runtime branch would be an option the admin offers and nothing honours.
 */
export const TRIGGER_TYPES = [
  /** Fires once as soon as the container boots. */
  "pageview",
  "dom_ready",
  "window_load",
  /** SPA navigation — rides the history wrap the tracker already installs. */
  "history_change",
  /** One delegated listener on `document`, capture phase. */
  "click",
  /** Same listener, but walks up to the nearest anchor first. */
  "link_click",
  "form_submit",
  /** Depth thresholds, each firing at most once per page. */
  "scroll",
  "element_visible",
  "timer",
  /** `backlex("signup")` or a `dataLayer.push({event})`. */
  "custom_event",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/**
 * Variables a condition may test.
 *
 * These are BROWSER-side values, which is what makes this list different from
 * `SEGMENT_FIELDS` — there is no `country` or `deviceType` here, because those
 * are derived server-side from headers the page cannot see. Anything not on
 * this list has to come through `variable`, which resolves a user-defined
 * variable by key.
 */
export const TAG_FIELDS = [
  "pageUrl",
  "pagePath",
  "pageHostname",
  "pageQuery",
  "referrer",
  "eventName",
  /** Populated only for click/link_click triggers; unset otherwise. */
  "clickId",
  "clickClasses",
  "clickText",
  "clickUrl",
  /** Populated only for form_submit. */
  "formId",
  "formAction",
] as const;
export type TagField = (typeof TAG_FIELDS)[number];

/** Numeric variables — separated because their operators are. */
export const TAG_NUMBER_FIELDS = ["scrollPercent"] as const;
export type TagNumberField = (typeof TAG_NUMBER_FIELDS)[number];

const TEXT_OPS = [
  "eq",
  "neq",
  "contains",
  "startsWith",
  "endsWith",
  "matchesRegex",
  "in",
  "isSet",
  "isNotSet",
] as const;
const NUMBER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

export type TagTextOp = (typeof TEXT_OPS)[number];
export type TagNumberOp = (typeof NUMBER_OPS)[number];

export type TagConditionNode =
  | { field: TagField; op: TagTextOp; value?: string | string[] }
  /** A user-defined variable, by its `tag_variables.key`. */
  | { variable: string; op: TagTextOp; value?: string | string[] }
  | { number: TagNumberField; op: TagNumberOp; value: number }
  | { all: TagConditionNode[] }
  | { any: TagConditionNode[] }
  | { not: TagConditionNode };

/** Total nodes in one condition. Generous for a human, bounded for a phone. */
const MAX_NODES = 40;
/** Nesting depth. Three levels of and/or is more than a UI should offer. */
const MAX_DEPTH = 4;
/** Values in an `in` list. */
const MAX_IN_VALUES = 50;
/**
 * Longest regex an operator may save.
 *
 * Not a safety proof — see the header. It is a blunt bound on how much rope a
 * pattern gets, chosen because every legitimate page-path regex anyone writes
 * is far under it.
 */
export const MAX_REGEX_LENGTH = 200;
/** Longest single comparison value. */
const MAX_VALUE_LENGTH = 500;
/** Longest CSS selector in a trigger config. */
const MAX_SELECTOR_LENGTH = 200;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const asText = (v: unknown, what: string, max = MAX_VALUE_LENGTH): string => {
  if (typeof v !== "string") throw new AppError("VALIDATION", `${what} must be a string.`);
  const t = v.trim();
  if (!t) throw new AppError("VALIDATION", `${what} must not be empty.`);
  if (t.length > max) {
    throw new AppError("VALIDATION", `${what} must be at most ${max} characters.`);
  }
  return t;
};

/**
 * Normalize the value half of a leaf, per operator.
 *
 * `isSet` / `isNotSet` take none — accepting one silently would let a UI bug
 * produce a condition that reads as "is set to X" and behaves as "is set".
 */
const normalizeValue = (op: TagTextOp, raw: unknown): string | string[] | undefined => {
  if (op === "isSet" || op === "isNotSet") return undefined;

  if (op === "in") {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new AppError("VALIDATION", "An `in` condition needs a non-empty list of values.");
    }
    if (raw.length > MAX_IN_VALUES) {
      throw new AppError("VALIDATION", `An \`in\` list may hold at most ${MAX_IN_VALUES} values.`);
    }
    return raw.map((v) => asText(v, "Each `in` value"));
  }

  if (op === "matchesRegex") {
    const pattern = asText(raw, "A regex pattern", MAX_REGEX_LENGTH);
    // Compile once here purely to reject syntax errors at save time. A pattern
    // that throws in the browser would fail closed and silently, and an
    // operator would have no way to tell that from "the condition did not
    // match". This is a syntax check, NOT a safety check.
    try {
      new RegExp(pattern);
    } catch {
      throw new AppError("VALIDATION", "That regular expression is not valid.");
    }
    return pattern;
  }

  return asText(raw, "A condition value");
};

/**
 * Validate an untrusted condition into a `TagConditionNode`.
 *
 * Throws rather than returning a partial tree, and callers must let it throw
 * on the read path too: a condition that half-parsed would fire a tag on pages
 * its author excluded.
 */
export const parseTagCondition = (input: unknown): TagConditionNode => {
  let nodes = 0;

  const walk = (raw: unknown, depth: number): TagConditionNode => {
    if (++nodes > MAX_NODES) {
      throw new AppError("VALIDATION", `A condition may hold at most ${MAX_NODES} tests.`);
    }
    if (depth > MAX_DEPTH) {
      throw new AppError("VALIDATION", `A condition may nest at most ${MAX_DEPTH} levels deep.`);
    }
    if (!isRecord(raw)) throw new AppError("VALIDATION", "Each condition must be an object.");

    if (Array.isArray(raw.all)) {
      if (raw.all.length === 0) throw new AppError("VALIDATION", "An `all` group must not be empty.");
      return { all: raw.all.map((n) => walk(n, depth + 1)) };
    }
    if (Array.isArray(raw.any)) {
      if (raw.any.length === 0) throw new AppError("VALIDATION", "An `any` group must not be empty.");
      return { any: raw.any.map((n) => walk(n, depth + 1)) };
    }
    if (raw.not !== undefined) return { not: walk(raw.not, depth + 1) };

    const op = String(raw.op ?? "");

    if (typeof raw.number === "string") {
      if (!(TAG_NUMBER_FIELDS as readonly string[]).includes(raw.number)) {
        throw new AppError(
          "VALIDATION",
          `Unknown numeric variable. Allowed: ${TAG_NUMBER_FIELDS.join(", ")}.`,
        );
      }
      if (!(NUMBER_OPS as readonly string[]).includes(op)) {
        throw new AppError("VALIDATION", `Unknown numeric comparison "${op}".`);
      }
      const value = Number(raw.value);
      if (!Number.isFinite(value)) {
        throw new AppError("VALIDATION", "A numeric condition needs a numeric value.");
      }
      return { number: raw.number as TagNumberField, op: op as TagNumberOp, value };
    }

    if (!(TEXT_OPS as readonly string[]).includes(op)) {
      throw new AppError("VALIDATION", `Unknown condition operator "${op}".`);
    }
    const typedOp = op as TagTextOp;
    const value = normalizeValue(typedOp, raw.value);

    if (typeof raw.variable === "string") {
      // Variable keys are the `{{key}}` an operator types, so they are bounded
      // to what a key can legally be rather than to free text.
      const key = raw.variable.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
        throw new AppError(
          "VALIDATION",
          "A variable key must start with a letter and hold only letters, digits and underscores (max 64).",
        );
      }
      return { variable: key, op: typedOp, value };
    }

    const field = String(raw.field ?? "");
    if (!(TAG_FIELDS as readonly string[]).includes(field)) {
      // Names what IS allowed rather than echoing the caller's string back —
      // an error response is not a place to reflect arbitrary input.
      throw new AppError("VALIDATION", `Unknown variable. Allowed: ${TAG_FIELDS.join(", ")}.`);
    }
    return { field: field as TagField, op: typedOp, value };
  };

  return walk(input, 1);
};

/** Scroll depths an operator may choose. A free-form percentage would be a
 *  listener firing on a value nobody reports on. */
export const SCROLL_THRESHOLDS = [25, 50, 75, 90] as const;

/** Floor on a timer trigger. Below a second it stops being a marketing trigger
 *  and becomes a way to pin a visitor's CPU. */
const MIN_TIMER_MS = 1_000;
const MAX_TIMER_MS = 3_600_000;
/** A timer that never stops is a memory leak on a long-lived SPA session. */
const MAX_TIMER_FIRES = 100;

export type TriggerConfig =
  | { kind: "none" }
  | { kind: "selector"; selector: string | null }
  | { kind: "scroll"; thresholds: number[] }
  | { kind: "visible"; selector: string; minPercent: number }
  | { kind: "timer"; intervalMs: number; maxFires: number }
  | { kind: "event"; eventName: string };

/**
 * Validate a trigger's type-specific settings.
 *
 * Kept beside the condition grammar rather than in the route because it is
 * re-run on READ, exactly like the condition — a trigger whose config no
 * longer validates must be dropped from the published artifact rather than
 * shipped in a shape the runtime does not expect.
 */
export const parseTriggerConfig = (type: string, input: unknown): TriggerConfig => {
  if (!(TRIGGER_TYPES as readonly string[]).includes(type)) {
    throw new AppError("VALIDATION", `Unknown trigger type. Allowed: ${TRIGGER_TYPES.join(", ")}.`);
  }
  const raw = isRecord(input) ? input : {};

  switch (type as TriggerType) {
    case "pageview":
    case "dom_ready":
    case "window_load":
    case "history_change":
      return { kind: "none" };

    case "click":
    case "link_click":
    case "form_submit": {
      // Null means "all of them" — one delegated listener either way, so an
      // absent selector costs nothing and is the common case.
      const sel = raw.selector;
      if (sel === undefined || sel === null || sel === "") return { kind: "selector", selector: null };
      return { kind: "selector", selector: asText(sel, "A CSS selector", MAX_SELECTOR_LENGTH) };
    }

    case "scroll": {
      const list = Array.isArray(raw.thresholds) ? raw.thresholds : [];
      const picked = [...new Set(list.map(Number))].filter((n) =>
        (SCROLL_THRESHOLDS as readonly number[]).includes(n),
      );
      if (picked.length === 0) {
        throw new AppError(
          "VALIDATION",
          `A scroll trigger needs at least one depth of ${SCROLL_THRESHOLDS.join(", ")}.`,
        );
      }
      return { kind: "scroll", thresholds: picked.sort((a, b) => a - b) };
    }

    case "element_visible": {
      const selector = asText(raw.selector, "A CSS selector", MAX_SELECTOR_LENGTH);
      const pct = Number(raw.minPercent ?? 50);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        throw new AppError("VALIDATION", "Visibility must be a percentage between 1 and 100.");
      }
      return { kind: "visible", selector, minPercent: Math.round(pct) };
    }

    case "timer": {
      const intervalMs = Number(raw.intervalMs);
      if (!Number.isFinite(intervalMs) || intervalMs < MIN_TIMER_MS || intervalMs > MAX_TIMER_MS) {
        throw new AppError(
          "VALIDATION",
          `A timer interval must be between ${MIN_TIMER_MS} and ${MAX_TIMER_MS} milliseconds.`,
        );
      }
      const rawFires = raw.maxFires === undefined ? 1 : Number(raw.maxFires);
      if (!Number.isFinite(rawFires) || rawFires < 1 || rawFires > MAX_TIMER_FIRES) {
        throw new AppError("VALIDATION", `A timer may fire between 1 and ${MAX_TIMER_FIRES} times.`);
      }
      return { kind: "timer", intervalMs: Math.round(intervalMs), maxFires: Math.round(rawFires) };
    }

    case "custom_event":
      return { kind: "event", eventName: asText(raw.eventName, "An event name", 120) };
  }
};
