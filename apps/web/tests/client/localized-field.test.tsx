/**
 * The admin item editor renders a per-locale editor for any `localized`
 * (sidecar) field — not just `i18n_text`. The value is a `{locale: value}` map;
 * each language gets its own input (number fields get a number input), and the
 * payload builder sends the map back as an object-of-locales.
 *
 * Settings don't resolve in the test (no backend) so the configured-locale list
 * falls back to `["en"]`; the editor still surfaces every locale already on the
 * row, which is what these assertions exercise.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
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

describe("ItemFields — localized (sidecar) editor", () => {
  afterEach(() => cleanup());

  test("a localized text field renders one input per locale on the row", () => {
    renderWithProviders(
      <Editor
        fields={[{ name: "title", type: "text", localized: true }]}
        initial={{ title: { en: "Hi", tr: "Merhaba" } }}
      />,
    );
    expect(screen.getByDisplayValue("Hi")).toBeTruthy();
    expect(screen.getByDisplayValue("Merhaba")).toBeTruthy();
  });

  test("a localized number field renders per-locale numeric inputs", () => {
    renderWithProviders(
      <Editor
        fields={[{ name: "price", type: "number", localized: true }]}
        initial={{ price: { en: 9.99, tr: 199 } }}
      />,
    );
    expect(screen.getByDisplayValue("9.99")).toBeTruthy();
    expect(screen.getByDisplayValue("199")).toBeTruthy();
  });
});
