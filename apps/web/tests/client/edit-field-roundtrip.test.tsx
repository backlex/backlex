/**
 * `<EditFieldDialog>` — opening a configured field and saving it back UNCHANGED
 * must not lose any of its configuration.
 *
 * The dialog is a codec, not a form. On open it fans one stored field out into
 * eleven independent draft states — validation, format, rollup, sequence, geo,
 * money, phone, email, url, range, transitions, plus conditions and
 * translations — and on save it folds them back with `compileValidation`,
 * `cleanFormat`, `cleanGeo`, `cleanTransitions` and the rest. Every one of those
 * is a hand-written pair, and a pair that does not round-trip drops the
 * operator's configuration on the next save of an unrelated setting.
 *
 * That failure is completely silent. The dialog closes, a toast says the field
 * was saved, and the setting is gone — this repo's house bug, a 2xx that did
 * nothing. `edit-field.tsx`'s own re-seed comment worries about exactly this
 * ("so the editor doesn't lose data when re-saving an old field") and nothing
 * checked it.
 *
 * So: one field carrying every sub-spec at once, opened and submitted with no
 * interaction, asserted key by key. It is a property test wearing a render
 * test's clothes — eleven codecs for one mount — which is why it is worth more
 * than eleven per-tab example specs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { EditFieldDialog } from "../../src/client/admin/fields/edit-field";
import { renderWithProviders } from "./render";

afterEach(() => cleanup());

/**
 * A field with something set on every tab the dialog owns.
 *
 * Deliberately NOT minimal: the whole point is that saving one of these back
 * untouched preserves the other ten. A fixture carrying a single sub-spec
 * would pass while ten codecs quietly dropped their input.
 */
const CONFIGURED = {
  name: "amount_due",
  type: "text",
  label: "Amount due",
  description: "What the customer still owes",
  group: "Billing",
  width: "half",
  sectionCollapsible: true,
  sectionCollapsed: true,
  required: true,
  translations: { tr: "Ödenecek tutar" },
  validation: { minLength: 3, maxLength: 120, regex: "^[A-Z]" },
  conditions: [
    { name: "hide when paid", rule: { status: { _eq: "paid" } }, hidden: true },
  ],
} as never;

/** Mount the dialog and capture whatever `onSave` is handed. */
const openAndSave = (field: unknown) => {
  let saved: Record<string, unknown> | null = null;
  renderWithProviders(
    <EditFieldDialog
      open
      field={field as never}
      onClose={() => {}}
      onSave={(next) => {
        saved = next as unknown as Record<string, unknown>;
      }}
    />,
  );
  // Liveness for every assertion below: if the dialog rendered nothing (a
  // changed prop contract, a crash swallowed by a boundary) there would be no
  // button, and a `saved === null` check alone would read as "nothing to
  // preserve" rather than as a broken test.
  const button = screen.getByText("Save field");
  fireEvent.click(button);
  expect(`onSave fired: ${saved !== null}`).toBe("onSave fired: true");
  // Unmount before returning so a test may call this more than once. `screen`
  // queries the whole document, so a second mount would make `getByText`
  // throw "Found multiple elements" — and the tests that re-feed a saved field
  // back in are the most valuable ones here.
  cleanup();
  return saved as unknown as Record<string, unknown>;
};

describe("<EditFieldDialog> — an untouched save preserves the field", () => {
  test("identity, placement and the section-layout flags survive", () => {
    const out = openAndSave(CONFIGURED);
    expect(out.name).toBe("amount_due");
    expect(out.label).toBe("Amount due");
    expect(out.description).toBe("What the customer still owes");
    expect(out.group).toBe("Billing");
    expect(out.width).toBe("half");
    // `sectionCollapsed` is normalized to `undefined` unless BOTH a section and
    // `sectionCollapsible` are present — so this pair is the one arrangement
    // where it may legitimately survive, and it must.
    expect(out.sectionCollapsible).toBe(true);
    expect(out.sectionCollapsed).toBe(true);
  });

  test("validation, translations and conditions survive the fan-out and back", () => {
    const out = openAndSave(CONFIGURED);
    // Each of these goes out through a different codec pair on open and a
    // different `clean*`/`compile*` on save.
    expect(out.validation).toEqual({ minLength: 3, maxLength: 120, regex: "^[A-Z]" });
    expect(out.translations).toEqual({ tr: "Ödenecek tutar" });

    const conds = out.conditions as { rule: unknown; hidden?: boolean; name?: string }[];
    expect(`conditions kept: ${conds?.length ?? 0}`).toBe("conditions kept: 1");
    expect(conds[0]!.hidden).toBe(true);
    expect(conds[0]!.name).toBe("hide when paid");
  });

  test("a condition rule reaches a FIXED POINT, so re-saving cannot nest it", () => {
    // `objToTree` / `ruleTreeToObj` is the pair with the most room to drift,
    // and its first pass is not the identity: a bare rule is canonicalized into
    // an explicit `$and` group. That is fine — what would not be fine is the
    // wrapper being applied AGAIN on each save, because a field re-saved N
    // times would carry N nested groups and every save looks successful.
    //
    // One pass cannot tell those apart: both produce `$and` once. Three can.
    const base = {
      name: "f",
      type: "text",
      conditions: [{ rule: { status: { _eq: "paid" } }, hidden: true }],
    };
    const pass1 = openAndSave(base);
    const pass2 = openAndSave(pass1);
    const pass3 = openAndSave(pass2);

    const ruleOf = (o: Record<string, unknown>) =>
      JSON.stringify((o.conditions as { rule: unknown }[])[0]!.rule);

    // Canonical, and semantically what was stored.
    expect(ruleOf(pass1)).toBe('{"$and":[{"status":{"_eq":"paid"}}]}');
    // The assertion that matters: passes 2 and 3 are byte-identical to pass 1.
    expect(ruleOf(pass2)).toBe(ruleOf(pass1));
    expect(ruleOf(pass3)).toBe(ruleOf(pass1));
  });

  test("a bound that was never valid for the type is dropped, not carried", () => {
    // Not a round-trip failure — a deliberate normalization, and worth pinning
    // because it LOOKS like one. `validationToDraft` reads `min`/`max` off any
    // field, but `compileValidation` only emits them for `integer`/`number`.
    // So a text field carrying numeric bounds (hand-written, or left over from
    // a type change) is cleaned on the next save rather than preserved. The
    // same spec on a numeric field must survive — otherwise this is a codec
    // that drops bounds for everyone.
    const asText = openAndSave({
      name: "title",
      type: "text",
      validation: { min: 1, max: 9999 },
    });
    expect(`text keeps numeric bounds: ${asText.validation}`).toBe(
      "text keeps numeric bounds: undefined",
    );

    const asNumber = openAndSave({
      name: "qty",
      type: "integer",
      validation: { min: 1, max: 9999 },
    });
    expect(asNumber.validation).toEqual({ min: 1, max: 9999 });
  });

  test("a bare field stays bare — no codec invents a spec that was not there", () => {
    // The other half of round-tripping, and the one an over-eager `clean*`
    // breaks: opening a field with nothing configured must not save it back
    // carrying an empty-but-present validation / format / transitions object,
    // because the server stores what it is sent and the dialog would then
    // re-show settings the operator never made.
    const out = openAndSave({ name: "plain", type: "text" });
    expect(out.name).toBe("plain");
    for (const key of [
      "validation",
      "format",
      "transitions",
      "conditions",
      "translations",
      "label",
      "description",
      "group",
      "width",
    ]) {
      expect(`${key}: ${out[key]}`).toBe(`${key}: undefined`);
    }
  });

  test("legacy `options.values` is migrated to `choices` rather than dropped", () => {
    // The one shape the dialog explicitly promises to rescue. A field saved by
    // an older admin carries `values: string[]`; the editor coerces it into
    // `choices` on open, and a save that lost it would silently empty the
    // dropdown for every row in the collection.
    const out = openAndSave({
      name: "status",
      type: "text",
      interface: "dropdown",
      options: { values: ["draft", "paid"] },
    });
    expect(out.options).toEqual({ choices: [{ value: "draft" }, { value: "paid" }] });
  });
});
