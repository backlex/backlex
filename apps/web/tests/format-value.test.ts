import { describe, expect, test } from "bun:test";
import { formatFieldValue } from "../src/client/admin/format-value";

const NOW = 1_700_000_000_000;

describe("formatFieldValue", () => {
  test("currency with precision", () => {
    const out = formatFieldValue(1234.5, { type: "number", format: { style: "currency", currency: "USD", precision: 2 } }, "en");
    expect(out).toBe("$1,234.50");
  });

  test("percent multiplies by 100", () => {
    expect(formatFieldValue(0.8, { type: "number", format: { style: "percent" } }, "en")).toBe("80%");
  });

  test("decimal groups thousands by default", () => {
    expect(formatFieldValue(1234567, { type: "integer", format: { style: "decimal" } }, "en")).toBe("1,234,567");
  });

  test("decimal can disable grouping", () => {
    expect(formatFieldValue(1234, { type: "integer", format: { style: "decimal", thousandSeparator: false } }, "en")).toBe("1234");
  });

  test("prefix/suffix wrap a plain value", () => {
    expect(formatFieldValue(5, { type: "number", format: { suffix: " kg" } }, "en")).toBe("5 kg");
  });

  test("timestamp relative", () => {
    const threeDaysAgo = NOW - 3 * 86400000;
    expect(formatFieldValue(threeDaysAgo, { type: "timestamp", format: { dateStyle: "relative" } }, "en", NOW)).toBe("3d ago");
  });

  test("timestamp date-only renders a locale date", () => {
    const out = formatFieldValue(NOW, { type: "timestamp", format: { dateStyle: "date" } }, "en", NOW);
    expect(out).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  test("null / empty → empty string", () => {
    expect(formatFieldValue(null, { type: "number" }, "en")).toBe("");
    expect(formatFieldValue("", { type: "text" }, "en")).toBe("");
  });

  test("i18n_text map collapses to one language", () => {
    expect(formatFieldValue({ en: "Hello", tr: "Merhaba" }, { type: "i18n_text" }, "en")).toBe("Hello");
  });

  test("no format hint → raw string", () => {
    expect(formatFieldValue(42, { type: "integer" }, "en")).toBe("42");
    expect(formatFieldValue("plain", { type: "text" }, "en")).toBe("plain");
  });
});
