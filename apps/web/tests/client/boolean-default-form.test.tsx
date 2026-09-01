/**
 * A toggle's declared default, in the item form.
 *
 * Found on the REAL SCREEN and by nothing else, which is the
 * [[testing-gaps-admin-ui]] class this directory exists to close. Every server
 * test was green: `POST /api/items/<slug>` with no `active` key applies the
 * column default and returns `true`, and there is a test for that. What no
 * server test could see is that **the form never omits the key**.
 *
 * `buildPayload` writes booleans unconditionally (`payload[f.name] = !!raw`),
 * and the draft seeded every boolean to a flat `false` regardless of its
 * declared default. So an operator who filled in a name and pressed Create
 * sent an explicit `active: false`, which is not a missing value the server can
 * default — it is a decision. The row was created, the API answered 201, and
 * the row was switched off.
 *
 * That is not cosmetic. `flag()` — the helper twenty-six templates use for
 * exactly this column — carries `retire`, so an inactive row is hidden from
 * every picker AND refuses to be referenced by a new write. The panel could
 * create a shipping rate, a discount, a sales channel or a configurator choice
 * that nothing could ever select, and nothing anywhere failed.
 *
 * The [[silent-success-is-the-house-bug]] shape: a 2xx that did the wrong thing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { SchemaField } from "../../src/client/admin/config";
import { ItemFields, useItemForm } from "../../src/client/admin/collections/item-form";
import { renderWithProviders } from "./render";

/** What `flag()` produces, plus the two neighbours that must NOT move. */
const FIELDS = [
  { name: "name", type: "text" },
  // `flag("active")` — default true, and `retire` is what makes it matter.
  { name: "active", type: "boolean", interface: "toggle", default: true, retire: {} },
  // A plain boolean that genuinely starts off.
  { name: "is_default", type: "boolean", interface: "toggle", default: false },
  // No default declared at all — still off, and still sent.
  { name: "featured", type: "boolean", interface: "toggle" },
] as unknown as SchemaField[];

function Editor({
  initial,
  onPayload,
}: {
  initial: Record<string, unknown> | null;
  onPayload: (p: Record<string, unknown>) => void;
}) {
  const form = useItemForm({
    schema: { slug: "things", fields: FIELDS } as any,
    initial: initial as any,
    active: true,
  });
  return (
    <>
      <ItemFields form={form} />
      <button type="button" onClick={() => onPayload(form.buildPayload() as any)}>
        submit
      </button>
    </>
  );
}

const switches = () => screen.getAllByRole("switch") as HTMLElement[];
const stateOf = (el: HTMLElement) =>
  el.getAttribute("aria-checked") ?? el.getAttribute("data-state");

describe("a boolean's declared default — the item form", () => {
  afterEach(() => cleanup());

  test("a new row opens with the column's default, not with everything off", () => {
    renderWithProviders(<Editor initial={null} onPayload={() => {}} />);
    const [active, isDefault, featured] = switches();
    expect(stateOf(active!)).toBe("true");
    expect(stateOf(isDefault!)).toBe("false");
    expect(stateOf(featured!)).toBe("false");
  });

  test("an untouched toggle submits its default — the assertion the 201 hid", () => {
    let payload: Record<string, unknown> = {};
    renderWithProviders(<Editor initial={null} onPayload={(p) => { payload = p; }} />);
    fireEvent.click(screen.getByText("submit"));
    // Before the fix this was `false`, and the created row was retired on
    // arrival: invisible to pickers, unreferenceable, and reported as success.
    expect(payload.active).toBe(true);
    expect(payload.is_default).toBe(false);
    expect(payload.featured).toBe(false);
  });

  test("turning the default OFF is still a decision the form sends", () => {
    // The fix must not make the toggle unturnoffable — seeding the draft is
    // not the same as forcing it.
    let payload: Record<string, unknown> = {};
    renderWithProviders(<Editor initial={null} onPayload={(p) => { payload = p; }} />);
    fireEvent.click(switches()[0]!);
    fireEvent.click(screen.getByText("submit"));
    expect(payload.active).toBe(false);
  });

  test("editing an existing row shows the SAVED value, never the default", () => {
    // The other half, and the one a naive fix breaks: a row that was
    // deliberately switched off must not re-open switched on, or an operator
    // saving an unrelated edit silently reactivates it.
    renderWithProviders(
      <Editor initial={{ id: "1", name: "Retired thing", active: false }} onPayload={() => {}} />,
    );
    expect(stateOf(switches()[0]!)).toBe("false");
  });
});
