import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import {
  buildRelationHops,
  FieldValidationEditor,
  validationToDraft,
} from "../../src/client/admin/fields/field-validation-editor";
import { renderWithProviders } from "./render";

/**
 * The value autocomplete in the cross-field rule builder has to offer the one
 * spelling the server supports for a cross-ROW invariant:
 * `$field.<relation>.<column>`.
 *
 * Without it the feature is reachable only from the docs — an admin sitting in
 * the Validation panel has no way to learn that a rule can look past its own
 * row, and typing the wrong spelling (a dotted key on the LEFT) is refused on
 * save with no hint from the box they typed it into.
 *
 * The filtering half matters as much as the offering half: every suggestion
 * must be something the server would accept, or the list teaches a mistake.
 * `buildRelationHops` mirrors the save-time refusals, and the first group here
 * pins each of them against a schema that contains exactly one of each trap.
 */

const TARGETS = [
  {
    slug: "warehouses",
    fieldDefs: [
      { name: "name", type: "text" },
      { name: "region", type: "text" },
      { name: "title", type: "text", localized: true },
      { name: "divider_1", type: "divider" },
      { name: "notice_1", type: "notice" },
    ],
  },
  { slug: "zones", fieldDefs: [{ name: "warehouse", type: "relation", to: "warehouses" }] },
  // Loaded, but every column of it is one a hop may not read.
  {
    slug: "layout_only",
    fieldDefs: [
      { name: "divider_1", type: "divider" },
      { name: "title", type: "text", localized: true },
    ],
  },
  // Declared with no fieldDefs at all — the shape a collection list takes
  // before its row has loaded.
  { slug: "unloaded" },
];

describe("buildRelationHops: only what the server would accept", () => {
  test("a relation offers its target's readable columns", () => {
    const hops = buildRelationHops(
      [{ name: "zone", type: "relation", to: "zones" }],
      TARGETS,
    );
    expect(hops).toEqual([{ relation: "zone", slug: "zones", columns: ["warehouse"] }]);
  });

  test("layout blocks and localized columns are left out", () => {
    // All three are refused at save time — a divider/notice owns no column, and
    // a localized value lives in the translations sidecar.
    const [hop] = buildRelationHops(
      [{ name: "wh", type: "relation", to: "warehouses" }],
      TARGETS,
    );
    expect(hop?.columns).toEqual(["name", "region"]);
  });

  test("relation_many is not hop-able", () => {
    // It points at many rows, and a comparison needs one.
    expect(
      buildRelationHops([{ name: "zones", type: "relation_many", to: "zones" }], TARGETS),
    ).toEqual([]);
  });

  test("a non-relation field contributes nothing", () => {
    expect(buildRelationHops([{ name: "code", type: "text" }], TARGETS)).toEqual([]);
  });

  test("a target that is not loaded yet is skipped rather than offered empty", () => {
    // A forward reference is allowed by the API, so this is a real state — and
    // an entry with no columns would be a dead end in the list.
    expect(
      buildRelationHops([{ name: "later", type: "relation", to: "unloaded" }], TARGETS),
    ).toEqual([]);
    expect(
      buildRelationHops([{ name: "later", type: "relation", to: "nope" }], TARGETS),
    ).toEqual([]);
  });

  test("a target whose every column is unreadable contributes nothing", () => {
    // Distinct from the not-loaded case above: this target IS loaded, so the
    // entry would be built and then offered with an empty column list — a
    // relation you can pick in the list and get nowhere with.
    expect(
      buildRelationHops([{ name: "layout", type: "relation", to: "layout_only" }], TARGETS),
    ).toEqual([]);
  });

  test("every relation on the collection contributes, in declaration order", () => {
    const hops = buildRelationHops(
      [
        { name: "wh", type: "relation", to: "warehouses" },
        { name: "code", type: "text" },
        { name: "zone", type: "relation", to: "zones" },
      ],
      TARGETS,
    );
    expect(hops.map((h) => h.relation)).toEqual(["wh", "zone"]);
  });
});

describe("the Validation panel offers hop values", () => {
  afterEach(cleanup);

  /** Every `value` the rule builder's datalist offers. */
  const suggestions = (): string[] =>
    [...document.querySelectorAll("datalist option")].map((o) => o.getAttribute("value") ?? "");

  const renderPanel = (
    hops: ReturnType<typeof buildRelationHops>,
    props: { name?: string; fields?: string[] } = {},
  ) =>
    renderWithProviders(
      <FieldValidationEditor
        type="relation"
        name={props.name}
        fields={props.fields ?? ["warehouse", "zone", "code"]}
        hops={hops}
        // Seeded with a rule so the Advanced panel is already open — that is
        // what `draftHasRule` keys the disclosure off, and it is the state an
        // admin editing an existing rule lands in.
        value={validationToDraft({ rule: { warehouse: { _eq: "$field.zone.warehouse" } } })}
        onChange={() => {}}
      />,
    );

  test("a one-hop reference is suggested alongside the siblings", () => {
    renderPanel(buildRelationHops([{ name: "zone", type: "relation", to: "zones" }], TARGETS));
    const values = suggestions();
    expect(values).toContain("$field.zone.warehouse");
    // The siblings it complements, and the shared dynamic vars, are still there.
    expect(values).toContain("$field.warehouse");
    expect(values).toContain("$user.id");
  });

  test("the suggestion is described by where it reads from", () => {
    // A bare `$field.zone.warehouse` in a list of forty is unreadable; the
    // description is what tells an admin which row the value comes off.
    renderPanel(buildRelationHops([{ name: "zone", type: "relation", to: "zones" }], TARGETS));
    const option = [...document.querySelectorAll("datalist option")].find(
      (o) => o.getAttribute("value") === "$field.zone.warehouse",
    );
    expect(option?.textContent).toBe(`warehouse on the zones row "zone" points at`);
  });

  test("nothing hop-shaped is offered when the collection has no relations", () => {
    // Asserted against a list that IS populated, so it cannot pass by the panel
    // having failed to render at all.
    renderPanel([]);
    const values = suggestions();
    expect(values.length).toBeGreaterThan(0);
    expect(values.filter((v) => v.startsWith("$field.") && v.includes(".", 7))).toEqual([]);
  });

  test("the hop hint appears only when there is a relation to hop through", () => {
    renderPanel(buildRelationHops([{ name: "zone", type: "relation", to: "zones" }], TARGETS));
    expect(screen.getByText(/look one relation out/i)).toBeTruthy();
    cleanup();
    renderPanel([]);
    expect(screen.queryByText(/look one relation out/i)).toBeNull();
  });

  test("the hint sits in the rule panel's text column, not loose in the layout", () => {
    // The geometry half of the mobile rule cannot be asserted here: happy-dom
    // loads no CSS and reports every getBoundingClientRect() as zero, so a rect
    // check would pass whatever the layout did — the same note as
    // `condition-editor.test.tsx`. What IS assertable is the mechanism that
    // keeps it from overflowing: the hint is a plain wrapping span sharing a
    // parent, and its type classes, with the line already above it. Nothing new
    // is introduced for a narrow viewport to break on.
    renderPanel(buildRelationHops([{ name: "zone", type: "relation", to: "zones" }], TARGETS));
    const hint = screen.getByText(/look one relation out/i).closest("span");
    const above = screen.getByText(/The row is rejected unless this matches/i).closest("span");
    expect(hint).toBeTruthy();
    expect(hint?.parentElement).toBe(above?.parentElement ?? null);
    expect(hint?.className).toBe(above?.className ?? "");
  });

  test("the rule's own field is offered, though the sibling list omits it", () => {
    // Both dialogs pass a sibling list with the edited field REMOVED — correct
    // for the conditions panel, where a field gating itself is circular, and
    // wrong here: a validation rule is almost always about the field it is
    // declared on (`{ end_date: { _gte: "$field.start_date" } }` lives on
    // `end_date`). Without `name` the stored left-hand value matched no option
    // and the picker rendered BLANK — an admin opening their own rule saw an
    // empty box where the field should be, and re-picking was impossible.
    renderPanel(buildRelationHops([{ name: "zone", type: "relation", to: "zones" }], TARGETS), {
      name: "warehouse",
      fields: ["zone", "code"],
    });
    const trigger = [...document.querySelectorAll("[role=combobox]")].find((el) =>
      (el.textContent ?? "").includes("warehouse"),
    );
    expect(trigger).toBeTruthy();
    // And it is offered as a value too, beside the siblings.
    expect(suggestions()).toContain("$field.warehouse");
  });

  test("a field already in the sibling list is not offered twice", () => {
    renderPanel([], { name: "warehouse" });
    const own = suggestions().filter((v) => v === "$field.warehouse");
    expect(own).toEqual(["$field.warehouse"]);
  });

  test("hops reach the value autocomplete and nowhere else", () => {
    // The server refuses a dotted key on the LEFT of a comparison, so a hop
    // must not leak into the field picker — offering one there would walk an
    // admin straight into a 422. Radix renders its listbox into a portal only
    // once opened, which happy-dom does not drive, so the claim is pinned the
    // way this harness can see it: the picker is a combobox showing a plain
    // column, and every hop-shaped string on the page is inside the datalist.
    renderPanel(buildRelationHops([{ name: "zone", type: "relation", to: "zones" }], TARGETS));
    // Every picker on the panel, not just the field one — the severity and
    // operator selects are comboboxes too, and none of them may show a path.
    const triggers = [...document.querySelectorAll("[role=combobox]")].map(
      (el) => el.textContent ?? "",
    );
    expect(triggers.some((t) => t.includes("warehouse"))).toBe(true);
    expect(triggers.filter((t) => t.includes("$field."))).toEqual([]);

    expect(suggestions().filter((v) => v.startsWith("$field.zone."))).toEqual([
      "$field.zone.warehouse",
    ]);
    const stray = [...document.querySelectorAll("*")].filter(
      (el) =>
        el.tagName !== "OPTION" &&
        el.children.length === 0 &&
        (el.textContent ?? "").includes("$field.zone."),
    );
    expect(stray).toEqual([]);
  });
});
