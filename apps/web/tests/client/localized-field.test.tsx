/**
 * The admin item editor localizes any `localized` (sidecar) field. The value is
 * a `{locale: value}` map, but the editor edits ONE language at a time: a locale
 * bar picks the active language and each localized field shows a single input
 * for it (so a 4-field × 6-locale record is 4 inputs, not 24). A `Compare` mode
 * splits each field into a read-only source column and an editable target.
 *
 * With no seeded settings the configured-locale list falls back to `["en"]`, so
 * the bar is hidden (one language needs no switcher) and the field shows the
 * default-language value. Seeding settings exercises the bar + switching.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { ItemFields, type SchemaField, useItemForm } from "../../src/client/admin/item-form";
import { renderWithProviders } from "./render";

function Editor({
  fields,
  initial,
}: {
  fields: SchemaField[];
  initial: Record<string, unknown> | null;
}) {
  const form = useItemForm({
    schema: { slug: "t", fields } as any,
    initial: initial as any,
    active: true,
  });
  return <ItemFields form={form} />;
}

/** Seed workspace settings so the editor sees more than one language. */
const seedLocales = (locales: string[], def = locales[0]) => (qc: QueryClient) =>
  qc.setQueryData(["settings"], { data: { i18nLocales: locales, i18nDefaultLocale: def } });

describe("ItemFields — localized (sidecar) editor", () => {
  afterEach(() => cleanup());

  test("shows the active-language input, not one input per locale", () => {
    // No seeded settings → locales fall back to ["en"], so only the default
    // language's value is on screen; the `tr` value stays in the map, unshown.
    renderWithProviders(
      <Editor
        fields={[{ name: "title", type: "text", localized: true }]}
        initial={{ title: { en: "Hi", tr: "Merhaba" } }}
      />,
    );
    expect(screen.getByDisplayValue("Hi")).toBeTruthy();
    expect(screen.queryByDisplayValue("Merhaba")).toBeNull();
  });

  test("a localized number field renders the active-language numeric input", () => {
    renderWithProviders(
      <Editor
        fields={[{ name: "price", type: "number", localized: true }]}
        initial={{ price: { en: 9.99, tr: 199 } }}
      />,
    );
    expect(screen.getByDisplayValue("9.99")).toBeTruthy();
    expect(screen.queryByDisplayValue("199")).toBeNull();
  });

  test("the locale bar switches the active language", () => {
    renderWithProviders(
      <Editor
        fields={[{ name: "title", type: "text", localized: true }]}
        initial={{ title: { en: "Hi", tr: "Merhaba" } }}
      />,
      { seed: seedLocales(["en", "tr", "de"]) },
    );
    // The bar is present (multi-locale) and starts on the default (en).
    expect(screen.getByText("Compare")).toBeTruthy();
    expect(screen.getByDisplayValue("Hi")).toBeTruthy();
    expect(screen.queryByDisplayValue("Merhaba")).toBeNull();

    // Switch to Turkish → the tr value shows, en drops off the input.
    fireEvent.click(screen.getByRole("button", { name: /^tr/i }));
    expect(screen.getByDisplayValue("Merhaba")).toBeTruthy();
    expect(screen.queryByDisplayValue("Hi")).toBeNull();
  });

  test("compare mode shows a read-only source next to the editable target", () => {
    renderWithProviders(
      <Editor
        fields={[{ name: "title", type: "text", localized: true }]}
        initial={{ title: { en: "Hi", tr: "Merhaba" } }}
      />,
      { seed: seedLocales(["en", "tr", "de"]) },
    );
    fireEvent.click(screen.getByText("Compare"));
    // Source (en) renders as read-only text; target (tr) as an editable input.
    expect(screen.getByText("Hi")).toBeTruthy();
    expect(screen.getByDisplayValue("Merhaba")).toBeTruthy();
    expect(screen.queryByDisplayValue("Hi")).toBeNull();
  });
});
