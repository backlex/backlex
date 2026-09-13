/**
 * A group key of `null` is a bucket of rows with NO value — not a row whose
 * value is the four characters `null`.
 *
 * Measured on a live public dashboard embed on 2026-08-27: a donut of
 * `count by category` over a column where 5 of 7 rows were NULL drew its
 * LARGEST slice labelled `null`, on a page the customer shows their own
 * stakeholders. The server was right — `/api/public/dashboards/<token>`
 * returns `{"label": null, "value": 5}` — and so was the PDF report renderer,
 * which prints `—` through `fmtCell`. Only the browser renderer stringified
 * it, so the same panel read `—` on paper and `null` on screen.
 */
import { describe, expect, test } from "bun:test";
import { seriesLabel } from "@backlex/core";

describe("seriesLabel", () => {
  test("an absent group key reads as a dash, not as text", () => {
    expect(seriesLabel(null)).toBe("—");
    expect(seriesLabel(undefined)).toBe("—");
  });

  test("an empty label reads as a dash too", () => {
    // It would otherwise draw nothing at all, which reads as a broken chart
    // rather than as an empty category.
    expect(seriesLabel("")).toBe("—");
    expect(seriesLabel("   ")).toBe("—");
  });

  test("a REAL value spelled 'null' is left alone", () => {
    // Hiding it would be the mirror-image bug: that row has a value.
    expect(seriesLabel("null")).toBe("null");
    expect(seriesLabel("undefined")).toBe("undefined");
    expect(seriesLabel(0)).toBe("0");
    expect(seriesLabel(false)).toBe("false");
  });

  test("the caller can name the empty bucket itself", () => {
    expect(seriesLabel(null, "(belirtilmemiş)")).toBe("(belirtilmemiş)");
  });
});
