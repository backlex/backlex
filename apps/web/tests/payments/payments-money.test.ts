/**
 * Minor-unit conversion for the payment ledger.
 *
 * `payment_transactions.amount` is an integer in the currency's minor unit, and
 * providers disagree about what they quote: Stripe and PayTR already send minor
 * units, iyzico quotes major-unit decimals. The conversion has two traps worth
 * pinning — binary floating point (`108.9 * 100` is not 10890) and currencies
 * whose minor unit is not two digits (¥500 is 500, not 50000).
 */
import { describe, expect, test } from "bun:test";
import { currencyExponent, toMajorUnits, toMinorUnits } from "@backlex/integrations/payments";

describe("currencyExponent", () => {
  test("defaults to 2 for the ordinary currencies", () => {
    for (const c of ["USD", "EUR", "GBP", "TRY", "CHF", "NOK"]) {
      expect(currencyExponent(c)).toBe(2);
    }
  });

  test("zero-decimal currencies have no minor unit", () => {
    for (const c of ["JPY", "KRW", "VND", "CLP", "ISK", "XOF"]) {
      expect(currencyExponent(c)).toBe(0);
    }
  });

  test("the Gulf dinars carry three digits", () => {
    for (const c of ["KWD", "BHD", "OMR", "JOD", "TND"]) {
      expect(currencyExponent(c)).toBe(3);
    }
  });

  test("is case-insensitive and falls back for junk", () => {
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent("")).toBe(2);
    expect(currencyExponent(null)).toBe(2);
    expect(currencyExponent("NOT-A-CURRENCY")).toBe(2);
  });

  test("an Object.prototype member name is junk, not an exponent", () => {
    // Upper-casing the key is what actually neutralises these, so this pins
    // the fallback end-to-end rather than the guard in isolation: an inherited
    // member would be an object, and `10 ** object` is NaN in the ledger.
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(currencyExponent(k)).toBe(2);
      expect(toMinorUnits("10.00", k)).toBe(1000);
    }
  });
});

describe("toMinorUnits", () => {
  test("converts a major-unit decimal to integer minor units", () => {
    expect(toMinorUnits("108.90", "TRY")).toBe(10890);
    expect(toMinorUnits(108.9, "TRY")).toBe(10890);
    expect(toMinorUnits("1.00", "USD")).toBe(100);
  });

  test("rounds instead of truncating, so binary float error never bills short", () => {
    // 108.9 * 100 === 10889.999999999998 — truncation gives 10889.
    expect(toMinorUnits(108.9, "TRY")).toBe(10890);
    expect(toMinorUnits(1.1, "USD")).toBe(110);
    expect(toMinorUnits(2.675, "USD")).toBe(268);
    expect(toMinorUnits(0.07, "USD")).toBe(7);
    expect(toMinorUnits(19.99, "EUR")).toBe(1999);
  });

  test("a zero-decimal currency passes through unscaled", () => {
    expect(toMinorUnits("500", "JPY")).toBe(500);
    expect(toMinorUnits(1200, "KRW")).toBe(1200);
  });

  test("a three-decimal currency scales by a thousand", () => {
    expect(toMinorUnits("1.500", "KWD")).toBe(1500);
  });

  test("zero and negatives (refunds) survive", () => {
    expect(toMinorUnits(0, "USD")).toBe(0);
    expect(toMinorUnits("-12.34", "USD")).toBe(-1234);
  });

  test("a non-numeric amount is null, not NaN", () => {
    expect(toMinorUnits(null, "USD")).toBeNull();
    expect(toMinorUnits(undefined, "USD")).toBeNull();
    expect(toMinorUnits("", "USD")).toBeNull();
    expect(toMinorUnits("abc", "USD")).toBeNull();
  });
});

describe("toMajorUnits", () => {
  test("renders the decimal string providers expect on the way out", () => {
    expect(toMajorUnits(10890, "TRY")).toBe("108.90");
    expect(toMajorUnits(100, "USD")).toBe("1.00");
    expect(toMajorUnits(1999, "EUR")).toBe("19.99");
  });

  test("a zero-decimal currency renders without a fraction", () => {
    expect(toMajorUnits(500, "JPY")).toBe("500");
  });

  test("a three-decimal currency keeps all three", () => {
    expect(toMajorUnits(1500, "KWD")).toBe("1.500");
  });

  test("round-trips against toMinorUnits", () => {
    for (const [amount, currency] of [
      ["108.90", "TRY"],
      ["19.99", "EUR"],
      ["500", "JPY"],
      ["1.500", "KWD"],
      ["0.07", "USD"],
    ] as const) {
      expect(toMajorUnits(toMinorUnits(amount, currency)!, currency)).toBe(amount);
    }
  });
});
