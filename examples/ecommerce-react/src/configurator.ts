/**
 * The configurator engine — the half of a configure-to-order product that is
 * not a form.
 *
 * A configured product is NOT a variant. A machine with three memory options,
 * four drive bays at five capacities each, six finishes and an OS choice is
 * `3 × 5⁴ × 6 × 2` = 22 500 combinations; materialising those as
 * `product_variants` rows is not a big catalog, it is a broken one. So the axes
 * that change what a unit COSTS or what goes IN it live on the template's
 * `modifier_sets` / `product_modifiers` / `modifier_values`, and this file
 * answers the two questions a configurator screen asks on every click: **what
 * is still selectable**, and **what does the build cost**.
 *
 * Kept deliberately pure — no client, no React, no fetch. The storefront calls
 * it on every click, and the same function is what a server-side check would
 * call before accepting the write. A rule enforced only inside a form is a rule
 * the next channel does not have.
 *
 * See `docs/product-configurator.md` for the model this reads.
 */

/** A choice on an axis — one `modifier_values` row. */
export interface Choice {
  id: string;
  label: string;
  code?: string | null;
  /** How the choice moves the price. */
  adjustment_type?: "fixed_amount" | "percent" | "fixed_price" | null;
  /** Money reads back as `{ amount, currency }`. */
  price_adjustment?: { amount: number; currency: string } | null;
  adjustment_percent?: number | null;
  is_default?: boolean | null;
  active?: boolean | null;
  position?: number | null;
}

/** A slot on one product — a `product_modifiers` row, with its set resolved.
 *  Four drive bays are four slots over ONE shared set, which is why the label
 *  lives here and the choices live on the set. */
export interface Slot {
  id: string;
  label: string;
  is_required: boolean;
  /** `max_select > 1` is a genuinely multi-choice axis. */
  maxSelect: number;
  setCode?: string | null;
  choices: Choice[];
  position?: number | null;
}

/** One `modifier_rules` row. */
export interface Rule {
  id: string;
  rule_type: "requires" | "excludes" | "hides" | "sets_default" | "validation";
  when_modifier: string;
  when_value?: string | null;
  then_modifier?: string | null;
  then_value?: string | null;
  message?: string | null;
  active?: boolean | null;
}

/** Slot id → the choice ids picked on it. A single-choice slot holds one. */
export type Selection = Record<string, string[]>;

export interface Adjustment {
  slotId: string;
  choiceId: string;
  label: string;
  amount: number;
}

export interface Resolved {
  /** Choice ids that the rules currently forbid — grey these out. */
  blocked: Set<string>;
  /** Slot ids the rules currently hide. */
  hidden: Set<string>;
  /** Slot ids the rules currently make mandatory (on top of `is_required`). */
  required: Set<string>;
  /** Human-readable reasons the build is not orderable yet. */
  violations: string[];
  /** Base + every adjustment. */
  total: number;
  /** The per-choice working behind `total`. */
  adjustments: Adjustment[];
  /** What the options added — this is the line's `options_total`. */
  optionsTotal: number;
  /** The compact build string — the line's `config_code`. */
  code: string;
  orderable: boolean;
}

const picked = (selection: Selection, slotId: string): string[] => selection[slotId] ?? [];

/** Pre-select every slot's default, the way a configurator opens on a real
 *  machine rather than on nothing. */
export function defaultSelection(slots: Slot[]): Selection {
  const out: Selection = {};
  for (const slot of slots) {
    const def = slot.choices.find((c) => c.is_default && c.active !== false);
    if (def) out[slot.id] = [def.id];
  }
  return out;
}

export function resolve(
  slots: Slot[],
  rules: Rule[],
  selection: Selection,
  basePrice: number,
): Resolved {
  const blocked = new Set<string>();
  const hidden = new Set<string>();
  const required = new Set<string>();
  const violations: string[] = [];
  const byId = new Map<string, { slot: Slot; choice: Choice }>();
  for (const slot of slots) {
    for (const choice of slot.choices) byId.set(choice.id, { slot, choice });
  }

  const fires = (r: Rule): boolean => {
    const on = picked(selection, r.when_modifier);
    return r.when_value ? on.includes(r.when_value) : on.length > 0;
  };
  const targetsOf = (r: Rule): string[] => {
    if (r.then_value) return [r.then_value];
    const slot = slots.find((s) => s.id === r.then_modifier);
    return slot ? slot.choices.map((c) => c.id) : [];
  };

  // One pass is enough for these five rule kinds: none of them SELECTS a value,
  // so no rule can newly fire because another one did. Add a kind that does (an
  // auto-add), and this becomes a fixpoint loop that needs a cycle guard.
  for (const r of rules) {
    if (r.active === false || !fires(r)) continue;
    if (r.rule_type === "excludes") for (const t of targetsOf(r)) blocked.add(t);
    if (r.rule_type === "hides" && r.then_modifier) hidden.add(r.then_modifier);
    if (r.rule_type === "requires" && r.then_modifier) required.add(r.then_modifier);
    if (r.rule_type === "validation") violations.push(r.message ?? "This combination is not available.");
  }

  const reasonFor = (choiceId: string): string => {
    const hit = rules.find(
      (r) => r.active !== false && fires(r) && r.rule_type === "excludes" && targetsOf(r).includes(choiceId),
    );
    const named = byId.get(choiceId)?.choice.label ?? "That option";
    return hit?.message ?? `${named} is not available with the rest of this build.`;
  };

  // A choice the rules have since forbidden is REPORTED, never silently
  // dropped. Telling somebody their build changed by itself is worse than
  // telling them which part to change.
  for (const slot of slots) {
    for (const choiceId of picked(selection, slot.id)) {
      if (blocked.has(choiceId)) violations.push(reasonFor(choiceId));
    }
    if (hidden.has(slot.id) && picked(selection, slot.id).length > 0) {
      violations.push(`${slot.label} does not apply to this build — clear it.`);
    }
  }
  for (const slot of slots) {
    if (hidden.has(slot.id)) continue;
    const need = slot.is_required || required.has(slot.id);
    if (need && picked(selection, slot.id).length === 0) {
      violations.push(`Choose a ${slot.label.toLowerCase()}.`);
    }
    if (picked(selection, slot.id).length > slot.maxSelect) {
      violations.push(`Pick at most ${slot.maxSelect} for ${slot.label.toLowerCase()}.`);
    }
  }

  // ── Price ────────────────────────────────────────────────────────────────
  // Every percentage is taken against the ORIGINAL base, never against a
  // running total: otherwise two 10% options compound to 21% and the order they
  // were clicked in changes the price.
  const chosen: { slot: Slot; choice: Choice }[] = [];
  for (const slot of slots) {
    if (hidden.has(slot.id)) continue;
    for (const choiceId of picked(selection, slot.id)) {
      const hit = byId.get(choiceId);
      if (hit) chosen.push(hit);
    }
  }

  // A `fixed_price` choice replaces the base outright, so it is resolved first
  // and the additive ones stack on whatever it left.
  const override = chosen.find((c) => c.choice.adjustment_type === "fixed_price");
  const start = override ? (override.choice.price_adjustment?.amount ?? 0) : basePrice;

  let total = start;
  const adjustments: Adjustment[] = [];
  for (const { slot, choice } of chosen) {
    if (choice.adjustment_type === "fixed_price") continue;
    const amount =
      choice.adjustment_type === "percent"
        ? (basePrice * (choice.adjustment_percent ?? 0)) / 100
        : (choice.price_adjustment?.amount ?? 0);
    if (amount === 0) continue;
    total += amount;
    adjustments.push({ slotId: slot.id, choiceId: choice.id, label: choice.label, amount });
  }

  // The build string, in the shape every configure-to-order seller keeps: a
  // Tesla's option codes, an Apple CTO part number. A summary, never the source
  // — `order_item_options` is the itemised record.
  const code = chosen
    .map(({ slot, choice }) => `${slot.setCode ?? ""}${choice.code ?? choice.id.slice(0, 4)}`)
    .join("/");

  return {
    blocked,
    hidden,
    required,
    violations,
    total,
    adjustments,
    optionsTotal: total - basePrice,
    code,
    orderable: violations.length === 0,
  };
}
