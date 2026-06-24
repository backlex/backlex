/**
 * The admin item editor renders a dedicated per-locale editor for `i18n_text`
 * fields (the no-code multi-language editor). Without it the field fell through
 * to the plain text input, which showed the `{ en, tr }` map as
 * "[object Object]" and wrote a bad string back.
 *
 * Settings (`useSettings` → `i18nLocales`) don't resolve in the test (no
 * backend), so the configured-locale list falls back to `["en"]`; the editor
 * still surfaces every locale already present on the row, which is what these
 * assertions exercise.
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

describe("ItemFields — i18n_text editor", () => {
  afterEach(() => cleanup());

  test("renders one input per locale on the row, preserving each value", () => {
    renderWithProviders(
      <Editor
        fields={[{ name: "title", type: "i18n_text" }]}
        initial={{ title: { en: "Hi", tr: "Merhaba" } }}
      />,
    );
    expect(screen.getByDisplayValue("Hi")).toBeTruthy();
    expect(screen.getByDisplayValue("Merhaba")).toBeTruthy();
  });

  test("wraps a bare legacy string so it stays editable", () => {
    renderWithProviders(
      <Editor
        fields={[{ name: "title", type: "i18n_text" }]}
        initial={{ title: "Legacy plain" }}
      />,
    );
    expect(screen.getByDisplayValue("Legacy plain")).toBeTruthy();
  });
});
