/**
 * Tag manager — the trigger vocabulary and the condition grammar.
 *
 * A trigger condition decides whether a marketing tag fires on a page, and it
 * is evaluated on the visitor's machine rather than ours. So this spec leads
 * with the two failures that actually cost something:
 *
 *  1. **A condition that half-parses.** `parseTagCondition` must throw rather
 *     than return a partial tree, on the read path as well as the write path.
 *     A tree missing one clause fires an advertising tag on a page its author
 *     excluded, and looks like it is working.
 *  2. **Unbounded work.** The caps are not tidiness — they bound a phone's
 *     main thread, and a regex is the one operator input with no upper bound
 *     on the work it can ask for.
 *
 * The third theme is the quiet one: an operator input that silently widens.
 * Several cases exist only to prove a value is REQUIRED where its absence
 * would change the meaning of the condition rather than reject it.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_REGEX_LENGTH,
  SCROLL_THRESHOLDS,
  TAG_FIELDS,
  TRIGGER_TYPES,
  parseTagCondition,
  parseTriggerConfig,
} from "../src/server/services/tag-conditions";

const ok = (input: unknown) => parseTagCondition(input);
const bad = (input: unknown) => expect(() => parseTagCondition(input)).toThrow();

describe("condition grammar", () => {
  test("accepts a leaf on every allowed field", () => {
    for (const field of TAG_FIELDS) {
      expect(ok({ field, op: "eq", value: "x" })).toEqual({ field, op: "eq", value: "x" });
    }
  });

  test("refuses an unknown field, and does not echo it back", () => {
    // The message names what IS allowed. Reflecting the caller's string into
    // an error body is how a validation message becomes an XSS gadget on
    // whatever renders it.
    try {
      parseTagCondition({ field: "<img src=x onerror=alert(1)>", op: "eq", value: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("Allowed:");
      expect(msg).not.toContain("onerror");
    }
  });

  test("refuses an unknown operator, and does not echo it back either", () => {
    bad({ field: "pagePath", op: "sqlInject", value: "x" });
    // Same rule as the field check. This message travels further than most —
    // a stored condition that stops validating surfaces its reason in the
    // publish report the admin renders.
    try {
      parseTagCondition({ field: "pagePath", op: "<script>alert(1)</script>", value: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("Allowed:");
      expect(msg).not.toContain("script");
    }
  });

  test("nests all/any/not", () => {
    const tree = ok({
      all: [
        { field: "pagePath", op: "startsWith", value: "/checkout" },
        { any: [{ field: "referrer", op: "isSet" }, { not: { field: "pageHostname", op: "eq", value: "staging.example.com" } }] },
      ],
    });
    expect(tree).toHaveProperty("all");
  });

  test("an empty group is refused, because it would match everything", () => {
    // `all: []` is vacuously true and `any: []` vacuously false. Both are
    // almost certainly a UI bug rather than an intent, and the `all` case is
    // the dangerous direction: a tag with no restriction at all.
    bad({ all: [] });
    bad({ any: [] });
  });
});

describe("caps", () => {
  test("refuses more than 40 nodes", () => {
    const many = Array.from({ length: 41 }, () => ({ field: "pagePath", op: "eq", value: "/" }));
    bad({ all: many });
  });

  test("refuses nesting past 4 levels", () => {
    let node: unknown = { field: "pagePath", op: "eq", value: "/" };
    for (let i = 0; i < 5; i++) node = { not: node };
    bad(node);
  });

  test("refuses an `in` list longer than 50", () => {
    const values = Array.from({ length: 51 }, (_, i) => `/p/${i}`);
    bad({ field: "pagePath", op: "in", value: values });
    // 50 is fine — the boundary is asserted from both sides so an off-by-one
    // in either direction fails here rather than in production.
    expect(ok({ field: "pagePath", op: "in", value: values.slice(0, 50) })).toBeTruthy();
  });

  test("refuses an empty `in` list", () => {
    bad({ field: "pagePath", op: "in", value: [] });
  });
});

describe("regex", () => {
  test("accepts a valid pattern and keeps it verbatim", () => {
    const pattern = "^/blog/[0-9]{4}/";
    expect(ok({ field: "pagePath", op: "matchesRegex", value: pattern })).toEqual({
      field: "pagePath",
      op: "matchesRegex",
      value: pattern,
    });
  });

  test("refuses a syntactically invalid pattern at save time", () => {
    // Not a safety check — a syntax check. A pattern that throws in the
    // browser fails closed and silently, and an operator cannot tell that
    // apart from "it did not match".
    bad({ field: "pagePath", op: "matchesRegex", value: "([a-z" });
  });

  test("refuses a pattern longer than the cap", () => {
    bad({ field: "pagePath", op: "matchesRegex", value: "a".repeat(MAX_REGEX_LENGTH + 1) });
  });

  test("a catastrophically backtracking pattern under the cap is ACCEPTED", () => {
    // This is the honest boundary, asserted so nobody later reads the cap as a
    // ReDoS defence. It is not one. Containment is that evaluation happens in
    // the visitor's browser, never in a Worker isolate — so the blast radius
    // is one tab, not the API.
    expect(ok({ field: "pagePath", op: "matchesRegex", value: "^(a+)+$" })).toBeTruthy();
  });
});

describe("value handling", () => {
  test("isSet / isNotSet take no value, and one is not silently kept", () => {
    // "is set to X" and "is set" are different conditions. Carrying a stray
    // value through would make a UI bug look like a working filter.
    expect(ok({ field: "referrer", op: "isSet", value: "ignored" })).toEqual({
      field: "referrer",
      op: "isSet",
      value: undefined,
    });
  });

  test("refuses a non-string value where a string is required", () => {
    bad({ field: "pagePath", op: "eq", value: { $ne: null } });
    bad({ field: "pagePath", op: "eq", value: 42 });
  });

  test("refuses an empty value", () => {
    bad({ field: "pagePath", op: "eq", value: "   " });
  });
});

describe("user-defined variables", () => {
  test("accepts a well-formed key", () => {
    expect(ok({ variable: "page_type", op: "eq", value: "product" })).toEqual({
      variable: "page_type",
      op: "eq",
      value: "product",
    });
  });

  test("refuses a key that is not an identifier", () => {
    // The key is interpolated into `{{key}}` lookups, so it is bounded to what
    // a key can legally be rather than to arbitrary text.
    bad({ variable: "page type", op: "eq", value: "x" });
    bad({ variable: "1page", op: "eq", value: "x" });
    bad({ variable: "a".repeat(65), op: "eq", value: "x" });
  });
});

describe("numeric conditions", () => {
  test("accepts scrollPercent with a numeric operator", () => {
    expect(ok({ number: "scrollPercent", op: "gte", value: 50 })).toEqual({
      number: "scrollPercent",
      op: "gte",
      value: 50,
    });
  });

  test("refuses a text operator on a numeric variable", () => {
    bad({ number: "scrollPercent", op: "contains", value: 50 });
  });

  test("refuses a non-finite value", () => {
    bad({ number: "scrollPercent", op: "gte", value: "many" });
  });
});

describe("trigger config", () => {
  test("every declared trigger type parses", () => {
    // Guards the guard: if a type is added to TRIGGER_TYPES without a branch
    // in parseTriggerConfig, the switch falls through and returns undefined,
    // which would reach the artifact as a trigger the runtime cannot arm.
    const sample: Record<string, unknown> = {
      scroll: { thresholds: [50] },
      element_visible: { selector: "#hero" },
      timer: { intervalMs: 5000 },
      custom_event: { eventName: "signup" },
    };
    for (const type of TRIGGER_TYPES) {
      expect(parseTriggerConfig(type, sample[type] ?? {})).toBeDefined();
    }
  });

  test("refuses an unknown trigger type", () => {
    expect(() => parseTriggerConfig("on_rage_click", {})).toThrow();
  });

  test("a click trigger with no selector means all clicks", () => {
    expect(parseTriggerConfig("click", {})).toEqual({ kind: "selector", selector: null });
    expect(parseTriggerConfig("click", { selector: "" })).toEqual({ kind: "selector", selector: null });
  });

  test("scroll keeps only known depths, deduped and ordered", () => {
    expect(parseTriggerConfig("scroll", { thresholds: [90, 50, 50, 33] })).toEqual({
      kind: "scroll",
      thresholds: [50, 90],
    });
  });

  test("scroll with no recognised depth is refused rather than silently empty", () => {
    // An empty threshold list would arm a listener that can never fire, which
    // reads in the admin as a configured trigger doing nothing.
    expect(() => parseTriggerConfig("scroll", { thresholds: [33] })).toThrow();
    expect(SCROLL_THRESHOLDS).not.toContain(33 as never);
  });

  test("element_visible requires a selector", () => {
    expect(() => parseTriggerConfig("element_visible", {})).toThrow();
    expect(parseTriggerConfig("element_visible", { selector: "#hero" })).toEqual({
      kind: "visible",
      selector: "#hero",
      minPercent: 50,
    });
  });

  test("a timer is floored, ceilinged, and bounded in how often it fires", () => {
    // Below a second this stops being a marketing trigger and becomes a way to
    // pin a visitor's CPU; unbounded fires leak on a long-lived SPA session.
    expect(() => parseTriggerConfig("timer", { intervalMs: 100 })).toThrow();
    expect(() => parseTriggerConfig("timer", { intervalMs: 5000, maxFires: 1000 })).toThrow();
    expect(parseTriggerConfig("timer", { intervalMs: 5000 })).toEqual({
      kind: "timer",
      intervalMs: 5000,
      maxFires: 1,
    });
  });

  test("custom_event requires an event name", () => {
    expect(() => parseTriggerConfig("custom_event", {})).toThrow();
  });
});
