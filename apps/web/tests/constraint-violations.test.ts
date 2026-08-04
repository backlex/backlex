/**
 * The constraint detectors, tested against the error shape each DRIVER actually
 * throws — which is the only way this bug class is catchable here.
 *
 * The trap: bun:sqlite (what the whole suite runs on) surfaces the engine's
 * words on the top-level `message`, so a detector that reads only the top link
 * is green through every integration test in this repo. D1 does not — drizzle
 * wraps the driver error and the words live on `cause`. So the API-level tests
 * cannot see the difference, and a unit test over the SHAPES is what pins it.
 *
 * Each "wrapped" fixture below is the shape drizzle produces: a wrapper whose
 * own message is always present (which is what defeated `a ?? b`), carrying the
 * real error on `cause`.
 */
import { describe, expect, test } from "bun:test";
import { isFkViolation, isUniqueViolation } from "../src/server/services/items/sql-helpers";

/** Drizzle's wrapper: a message of its own, the driver error on `cause`. */
const wrapped = (cause: unknown) =>
  Object.assign(new Error('Failed query: insert into "c_x" ("id") values (?)'), { cause });

describe("a unique violation is recognised however the driver wraps it", () => {
  test("D1 — the words are on the cause, never on the wrapper", () => {
    // The shape that answered 500 in production until 2026-08-04. The wrapper's
    // own message is truthy, so `err.message ?? err.cause?.message` stopped
    // there and never saw this string at all.
    const d1 = Object.assign(new Error("D1_ERROR: UNIQUE constraint failed: c_x.email"), {
      cause: undefined,
    });
    expect(isUniqueViolation(wrapped(d1))).toBe(true);
  });

  test("bun:sqlite — the words are on the top-level message", () => {
    // Green before the fix too. Kept so a future edit cannot buy the cause
    // chain by dropping the case the local suite actually exercises.
    expect(isUniqueViolation(new Error("UNIQUE constraint failed: c_x.email"))).toBe(true);
  });

  test("bun:sqlite — the driver code, with no useful message", () => {
    expect(
      isUniqueViolation(Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" })),
    ).toBe(true);
    expect(
      isUniqueViolation(Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" })),
    ).toBe(true);
  });

  test("the extended result code in the MESSAGE, not on a `code` field", () => {
    // The booking twin checked for this string in the message; the item-path
    // twin only ever checked it as a `code`. Note `/unique constraint/i` does
    // NOT match it — the words are the other way round — so consolidating the
    // two without this line would have silently narrowed the guard.
    expect(isUniqueViolation(wrapped(new Error("SQLITE_CONSTRAINT_UNIQUE")))).toBe(true);
    expect(isUniqueViolation(wrapped(new Error("SQLITE_CONSTRAINT_PRIMARYKEY")))).toBe(true);
    expect(isFkViolation(wrapped(new Error("SQLITE_CONSTRAINT_FOREIGNKEY")))).toBe(true);
    // Proving the claim above rather than asserting it: the regex alone misses.
    expect(/unique constraint/i.test("SQLITE_CONSTRAINT_UNIQUE")).toBe(false);
  });

  test("postgres — code 23505 on the wrapped error", () => {
    const pgErr = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    expect(isUniqueViolation(pgErr)).toBe(true);
    // The code alone, buried, with no matching words anywhere.
    expect(isUniqueViolation(wrapped(Object.assign(new Error("nope"), { code: "23505" })))).toBe(true);
  });

  test("a cause chain deeper than one link still resolves", () => {
    expect(isUniqueViolation(wrapped(wrapped(new Error("UNIQUE constraint failed: c_x.email"))))).toBe(true);
  });

  test("NON-VACUOUS: an unrelated failure is not a unique violation", () => {
    // Without this the fix could be "return true", and the 409 would swallow
    // every real 500 on the write path.
    expect(isUniqueViolation(wrapped(new Error("no such table: c_x")))).toBe(false);
    expect(isUniqueViolation(new Error("Failed query: insert into \"c_x\""))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    // A FK violation is a DIFFERENT answer — 422, not 409.
    expect(isUniqueViolation(wrapped(new Error("FOREIGN KEY constraint failed")))).toBe(false);
  });

  test("a cyclic cause chain terminates", () => {
    const a = new Error("Failed query") as Error & { cause?: unknown };
    const b = new Error("Failed query") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
  });
});

describe("a foreign-key violation is recognised the same way", () => {
  test("D1 — on the cause", () => {
    expect(isFkViolation(wrapped(new Error("D1_ERROR: FOREIGN KEY constraint failed")))).toBe(true);
  });

  test("the driver code, and postgres 23503", () => {
    expect(
      isFkViolation(Object.assign(new Error("boom"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" })),
    ).toBe(true);
    expect(isFkViolation(wrapped(Object.assign(new Error("boom"), { code: "23503" })))).toBe(true);
  });

  test("NON-VACUOUS: a unique violation is not an FK violation", () => {
    expect(isFkViolation(wrapped(new Error("UNIQUE constraint failed: c_x.email")))).toBe(false);
    expect(isFkViolation(new Error("no such table"))).toBe(false);
    expect(isFkViolation(null)).toBe(false);
  });
});
