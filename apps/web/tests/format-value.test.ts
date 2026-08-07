import { describe, expect, test } from "bun:test";
import { fieldLabel, formatFieldValue } from "../src/client/admin/lib/format-value";

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

  test("localized map collapses to one language", () => {
    expect(
      formatFieldValue({ en: "Hello", tr: "Merhaba" }, { type: "text", localized: true }, "en"),
    ).toBe("Hello");
  });

  test("no format hint → raw string", () => {
    expect(formatFieldValue(42, { type: "integer" }, "en")).toBe("42");
    expect(formatFieldValue("plain", { type: "text" }, "en")).toBe("plain");
  });
});

describe("fieldLabel", () => {
  test("prefers the locale translation, then label, then name", () => {
    const f = { name: "price", label: "Price", translations: { tr: "Fiyat", de: "Preis" } };
    expect(fieldLabel(f, "tr")).toBe("Fiyat");
    expect(fieldLabel(f, "de")).toBe("Preis");
    expect(fieldLabel(f, "en")).toBe("Price"); // no en translation → label
    expect(fieldLabel({ name: "price" }, "tr")).toBe("price"); // no label/translations → name
  });
});
