/**
 * The configurator engine, tested where it can actually fail.
 *
 * `docs/product-configurator.md` says the rules are DATA and the evaluator is
 * the whole engine — which makes the evaluator the one piece whose bugs are
 * invisible to every schema guard in this suite. A wrong `excludes` does not
 * violate a constraint, drop a row or throw; it sells a machine that cannot be
 * built, and nobody finds out until it reaches a bench.
 *
 * It lives in `examples/ecommerce-react` on purpose: the vertical does not
 * belong in the engine or in the SDK, whose namespaces are all generic backlex
 * features. That placement is exactly why it is imported here rather than left
 * with no coverage — an example is the reference implementation people copy,
 * so a bug in it is a bug in every store that copied it.
 *
 * The module is dependency-free by construction (no client, no React, no
 * fetch), which is what makes this import safe from a server test file.
 */
import { describe, expect, test } from "bun:test";
import {
  defaultSelection,
  resolve,
  type Rule,
  type Slot,
} from "../../../examples/ecommerce-react/src/configurator";

const money = (amount: number) => ({ amount, currency: "USD" });

/** A machine: memory, two drive bays over one shared set, a finish. */
const slots = (): Slot[] => [
  {
    id: "slot-ram",
    label: "Memory",
    is_required: true,
    maxSelect: 1,
    setCode: "RAM",
    choices: [
      { id: "ram-16", label: "16 GB", code: "16GB", adjustment_type: "fixed_amount", price_adjustment: money(0), is_default: true },
      { id: "ram-32", label: "32 GB", code: "32GB", adjustment_type: "fixed_amount", price_adjustment: money(240) },
      { id: "ram-64", label: "64 GB", code: "64GB", adjustment_type: "fixed_amount", price_adjustment: money(560) },
    ],
  },
  {
    id: "slot-bay1",
    label: "Drive bay 1",
    is_required: true,
    maxSelect: 1,
    setCode: "SSD",
    choices: [
      { id: "ssd-1t", label: "1 TB", code: "1TB", adjustment_type: "fixed_amount", price_adjustment: money(90) },
      { id: "ssd-2t", label: "2 TB", code: "2TB", adjustment_type: "fixed_amount", price_adjustment: money(190) },
    ],
  },
  {
    id: "slot-bay2",
    label: "Drive bay 2",
    is_required: false,
    maxSelect: 1,
    setCode: "SSD",
    choices: [
      { id: "ssd2-1t", label: "1 TB", code: "1TB", adjustment_type: "fixed_amount", price_adjustment: money(90) },
    ],
  },
  {
    id: "slot-care",
    label: "Care plan",
    is_required: false,
    maxSelect: 2,
    setCode: "CARE",
    choices: [
      { id: "care-2y", label: "2 years", code: "2Y", adjustment_type: "percent", adjustment_percent: 10 },
      { id: "care-acc", label: "Accident cover", code: "ACC", adjustment_type: "percent", adjustment_percent: 10 },
    ],
  },
];

const BASE = 1000;

describe("the configurator engine", () => {
  test("a percentage is taken against the base, so two of them do not compound", () => {
    // The bug this exists to prevent is silent and order-dependent: fold each
    // percent into a running total and two 10% options come to 21%, and
    // clicking them in the other order gives the same wrong number, so nothing
    // looks inconsistent. 10% + 10% of 1000 is 200, not 210.
    const r = resolve(slots(), [], { "slot-care": ["care-2y", "care-acc"] }, BASE);
    expect(r.optionsTotal).toBe(200);
    expect(r.total).toBe(1200);
    expect(r.adjustments.map((a) => a.amount)).toEqual([100, 100]);
  });

  test("a fixed price replaces the base rather than adding to it", () => {
    const withOverride = slots();
    withOverride.push({
      id: "slot-deal",
      label: "Bundle",
      is_required: false,
      maxSelect: 1,
      setCode: "DEAL",
      choices: [
        { id: "deal-flat", label: "Student flat rate", code: "STU", adjustment_type: "fixed_price", price_adjustment: money(750) },
      ],
    });
    const r = resolve(withOverride, [], { "slot-deal": ["deal-flat"], "slot-ram": ["ram-32"] }, BASE);
    // 750 replaces the 1000 base; the memory upgrade still stacks on top.
    expect(r.total).toBe(990);
    // And the override is NOT double-counted as an adjustment line.
    expect(r.adjustments.map((a) => a.choiceId)).toEqual(["ram-32"]);
  });

  test("an excluded choice is blocked, and one already selected is reported rather than dropped", () => {
    // Silently un-picking the shopper's choice is the tempting fix and the
    // wrong one: a build that changes by itself is worse than a build that says
    // which part to change.
    const rules: Rule[] = [
      {
        id: "r1",
        rule_type: "excludes",
        when_modifier: "slot-ram",
        when_value: "ram-64",
        then_modifier: "slot-bay2",
        then_value: "ssd2-1t",
        message: "Drive bay 2 is occupied by the 64 GB module.",
      },
    ];

    const idle = resolve(slots(), rules, { "slot-ram": ["ram-16"], "slot-bay1": ["ssd-1t"] }, BASE);
    expect(idle.blocked.has("ssd2-1t")).toBe(false);
    expect(idle.orderable).toBe(true);

    const fired = resolve(slots(), rules, { "slot-ram": ["ram-64"], "slot-bay1": ["ssd-1t"] }, BASE);
    expect(fired.blocked.has("ssd2-1t")).toBe(true);
    expect(fired.orderable).toBe(true); // blocked, but not selected — still fine

    const conflict = resolve(
      slots(),
      rules,
      { "slot-ram": ["ram-64"], "slot-bay1": ["ssd-1t"], "slot-bay2": ["ssd2-1t"] },
      BASE,
    );
    expect(conflict.orderable).toBe(false);
    expect(conflict.violations).toContain("Drive bay 2 is occupied by the 64 GB module.");
    // Still selected — the engine reports, the shopper decides.
    expect(conflict.adjustments.some((a) => a.choiceId === "ssd2-1t")).toBe(true);
  });

  test("a hidden slot stops being asked for AND stops being charged", () => {
    // Half a fix is worse than none: hiding the control while still summing its
    // adjustment produces a price with a line nobody can see.
    const rules: Rule[] = [
      { id: "r2", rule_type: "hides", when_modifier: "slot-ram", when_value: "ram-64", then_modifier: "slot-bay2" },
    ];
    const r = resolve(
      slots(),
      rules,
      { "slot-ram": ["ram-64"], "slot-bay1": ["ssd-1t"], "slot-bay2": ["ssd2-1t"] },
      BASE,
    );
    expect(r.hidden.has("slot-bay2")).toBe(true);
    expect(r.adjustments.some((a) => a.slotId === "slot-bay2")).toBe(false);
    expect(r.total).toBe(BASE + 560 + 90);
    // And a stale pick on a hidden slot is surfaced, not silently ignored.
    expect(r.orderable).toBe(false);
  });

  test("a required slot with nothing chosen blocks the build, and naming it is the point", () => {
    const empty = resolve(slots(), [], {}, BASE);
    expect(empty.orderable).toBe(false);
    expect(empty.violations).toContain("Choose a memory.");
    expect(empty.violations).toContain("Choose a drive bay 1.");

    const rules: Rule[] = [
      { id: "r3", rule_type: "requires", when_modifier: "slot-ram", when_value: "ram-64", then_modifier: "slot-bay2" },
    ];
    const needsBay2 = resolve(slots(), rules, { "slot-ram": ["ram-64"], "slot-bay1": ["ssd-1t"] }, BASE);
    expect(needsBay2.required.has("slot-bay2")).toBe(true);
    expect(needsBay2.orderable).toBe(false);
  });

  test("a multi-choice slot holds several, and refuses more than its cap", () => {
    const two = resolve(slots(), [], { "slot-care": ["care-2y", "care-acc"] }, BASE);
    expect(two.violations.some((v) => v.includes("at most"))).toBe(false);

    const capped = slots();
    const care = capped.find((s) => s.id === "slot-care");
    if (care) care.maxSelect = 1;
    const over = resolve(capped, [], { "slot-care": ["care-2y", "care-acc"] }, BASE);
    expect(over.orderable).toBe(false);
    expect(over.violations.some((v) => v.includes("at most 1"))).toBe(true);
  });

  test("a validation rule refuses the build in its own words", () => {
    const rules: Rule[] = [
      {
        id: "r4",
        rule_type: "validation",
        when_modifier: "slot-ram",
        when_value: "ram-16",
        message: "16 GB is not offered with this chassis any more.",
      },
    ];
    const r = resolve(slots(), rules, { "slot-ram": ["ram-16"], "slot-bay1": ["ssd-1t"] }, BASE);
    expect(r.orderable).toBe(false);
    expect(r.violations).toEqual(["16 GB is not offered with this chassis any more."]);
  });

  test("an inactive rule does nothing", () => {
    // `active` is a column an operator flips to take a rule out of service. A
    // rule that kept firing while switched off would be unfixable from the admin.
    const rules: Rule[] = [
      {
        id: "r5",
        rule_type: "excludes",
        when_modifier: "slot-ram",
        when_value: "ram-64",
        then_modifier: "slot-bay2",
        then_value: "ssd2-1t",
        active: false,
      },
    ];
    const r = resolve(slots(), rules, { "slot-ram": ["ram-64"], "slot-bay1": ["ssd-1t"] }, BASE);
    expect(r.blocked.size).toBe(0);
  });

  test("the build string composes set and choice codes, in slot order", () => {
    const r = resolve(
      slots(),
      [],
      { "slot-ram": ["ram-32"], "slot-bay1": ["ssd-1t"], "slot-bay2": ["ssd2-1t"] },
      BASE,
    );
    // Two bays over ONE set, and the code still tells them apart by position —
    // which is why the slot contributes the set code and the choice the value.
    expect(r.code).toBe("RAM32GB/SSD1TB/SSD1TB");
    expect(r.optionsTotal).toBe(240 + 90 + 90);
  });

  test("a rule with no `when_value` fires on any choice in its slot", () => {
    const rules: Rule[] = [
      { id: "r6", rule_type: "excludes", when_modifier: "slot-bay2", then_modifier: "slot-care", then_value: "care-acc" },
    ];
    const idle = resolve(slots(), rules, { "slot-ram": ["ram-16"], "slot-bay1": ["ssd-1t"] }, BASE);
    expect(idle.blocked.has("care-acc")).toBe(false);
    const fired = resolve(
      slots(),
      rules,
      { "slot-ram": ["ram-16"], "slot-bay1": ["ssd-1t"], "slot-bay2": ["ssd2-1t"] },
      BASE,
    );
    expect(fired.blocked.has("care-acc")).toBe(true);
  });

  test("the configurator opens on the defaults, not on nothing", () => {
    const sel = defaultSelection(slots());
    expect(sel["slot-ram"]).toEqual(["ram-16"]);
    // No default declared on the bays, so they open unanswered — and the
    // required one is what the violations then ask for.
    expect(sel["slot-bay1"]).toBeUndefined();
    const r = resolve(slots(), [], sel, BASE);
    expect(r.violations).toContain("Choose a drive bay 1.");
  });
});
