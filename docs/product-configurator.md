---
title: Product configurator
description: Configure-to-order products — shared option sets, per-choice price adjustments, compatibility rules, the components a choice consumes, and add-on products bought alongside. The shape that sells a machine with four drive bays without materialising six figures of variants.
---

A variant is a **stocked unit**. A configuration is a **decision the buyer
makes about one**. Treating the second as the first is the single mistake that
makes a configurable catalog unusable, and it fails by multiplication: a laptop
with 3 memory options, 4 drive bays at 5 capacities each, 6 finishes and an OS
choice is `3 × 5⁴ × 6 × 2` — **22 500** rows to create, price, publish, translate
and keep in stock, for **one model**. Add a bay and it is 112 500.

So `product_variants` stays what it is — the handful of axes genuinely stocked
as separate units — and everything that changes what a unit *costs* or what goes
*in* it lives on the configurator tables below.

## How the industry does this

Every configure-to-order seller keeps the same four layers apart, and it is
worth knowing which layer a problem belongs to before reaching for a table.

**The model layer stores codes, not SKUs.** A Tesla's build is a comma-delimited
list of option codes against one model — `MDL3`, `PPSW` (Pearl White),
`W38B` (18" Aero), `IN3PB` (all-black premium) — not a pre-built variant.
Apple ships a handful of *shelf* configurations with ordinary part numbers
(`MD101LL/A`) and mints a `Z…` part number for anything configure-to-order.
SAP's Variant Configuration calls it one **configurable material** with
**characteristics**, where "one configurable material covers all variants".

**The rule layer is a constraint system, not branches in a storefront.**
Renault's range is on the order of **10²¹** configurations and its configurator
is built on constraint satisfaction with knowledge compilation. Configit's
Virtual Tabulation compiles the entire valid space to a decision diagram up
front, so a click at runtime is "simply a look-up, rather than a re-calculation"
— which is why a good configurator greys an impossible option out instantly
instead of failing at checkout. The CPQ vocabulary for these rules is
standardised: **inclusion, exclusion, validation, recommendation, replacement**.

**The price layer is base + deltas, resolved server-side and frozen.** The
option carries the adjustment; the resolved price is snapshotted onto the order
and never re-derived from a catalog that has since moved.

**The fulfillment layer explodes the configuration into components.** SAP uses a
**super BOM** whose object dependencies "select exactly the right BOM components
… to produce a variant". Shopify's bundles do the retail version: the order's
lines are the *components*, each carrying a reference back to the bundle parent,
so stock moves on the parts while the buyer sees one product.

**You almost certainly do not need a BDD.** Compilation exists because 10²¹
cannot be enumerated. A catalog with a few dozen rules per product evaluates
directly, in under a millisecond. Reach for the algorithm below, not a solver.

## Variants and modifiers, together

They are not alternatives, and a catalog that made you choose between them would
be unusable. The question each answers is different:

| | `product_variants` | Modifiers |
|---|---|---|
| Answers | **which unit leaves the shelf** | **what was decided about it** |
| Has | its own SKU, barcode, stock, price | a price adjustment, optionally a component |
| Cost of an axis | one row per combination | one row per choice |
| Use for | screen size, base model, colourway you stock | memory, drives, engraving, warranty |

A laptop is **picked** as a variant — 14" and 16" are separately stocked units
with their own SKUs — and then **configured** on top. One line holds both:

```
order_items          variant → the 16" unit, unit_price 1200
order_item_options   Memory  = 32 GB   +240
                     Bay 1   = 1 TB     +90
                     Finish  = Black     +0
                     → options_total 330, line_total = qty × 1530
```

The rule for deciding which axis something belongs on is **stock**: if you count
it separately in a warehouse, it is a variant. If you don't, it is a modifier —
even when it consumes a part, because the part is counted, not the choice.

Keep the variant axes few. Three variants × twelve configured slots is fifteen
rows; twelve variant axes is a catalog nobody can publish.

## The model

| Collection | What it is |
|---|---|
| `modifier_sets` | The axis, defined **once** — "Memory", "M.2 SSD", "Finish". Shared across every product that has it. |
| `modifier_values` | Its choices, each with a price adjustment, a code, and optionally the stocked unit it consumes. |
| `product_modifiers` | A **slot**: this product carries that set, here, with this label. |
| `modifier_rules` | Which combinations are legal. |
| `product_addons` | A separate product bought alongside — a keyboard, a bag. |
| `cart_item_options` / `order_item_options` | What was actually chosen, snapshotted onto the line. |

Three things about that shape are load-bearing.

**A set is shared, and a slot is per-product.** A fifty-model range shares one
"Memory" set. Repricing 32 GB is one edit, not fifty — and it is the fiftieth
that gets missed. `product_modifiers` is deliberately **not** unique on
`(product, modifier_set)`: a machine with four drive bays is **four slots over
one set**, each separately labelled, priced and stocked. A per-product option
list cannot express that at all without four duplicated lists that drift apart
on the first price change.

**A choice may consume a real unit.** `modifier_values.component_variant` +
`consumes_qty` point at a stocked `product_variants` row. An engraving consumes
nothing and leaves it empty; a 64 GB memory module is something somebody has to
have on a shelf, and the configured product still leaves as one line while the
**component's** `inventory_levels` is what runs out.

**An add-on is not a modifier.** A modifier changes the unit; an add-on *is* a
unit, with its own SKU, stock, tax class and return path. It becomes its own
line whose `parent` names the line it was bought with — Shopify's component
model, for exactly the reason Shopify has it: a returned mouse is a returned
mouse, not a partial refund of a laptop.

### The line

A configured line carries both halves of its price and its identity:

```
unit_price     the base — the variant's price
options_total  what the configuration added
line_total     GENERATED as qty * (unit_price + COALESCE(options_total, 0))
config_code    the compact build string, e.g. MT301/32GB/1TB/BLK
parent         set on an add-on line, naming the line it came with
```

`line_total` is a generated column, so it is refused as input like every other
derived amount. The `COALESCE` is not defensive habit: a bare
`unit_price + options_total` is `NULL` for every line that configures nothing,
which is most of them.

`config_code` is the Tesla/Apple move — one string that a picker, a build sheet
and a support agent can all read without joining four tables. It is a
**summary**, never the source: `order_item_options` is the itemised record, and
the code is composed from `modifier_sets.code` + `modifier_values.code`.

## Prices

`modifier_values.adjustment_type` decides how a choice moves the price:

| Type | Effect on the line |
|---|---|
| `fixed_amount` | `+ price_adjustment` |
| `percent` | `+ base × adjustment_percent / 100` |
| `fixed_price` | replaces the base outright |

A `number` or `checkbox` slot needs no special case: give the set one choice
holding the per-unit price, and `qty` on the chosen-option row multiplies it.

Every adjustment is a `money` value denominated by its own row's `currency`, and
the snapshot on the line is what was charged — see
[money](/docs/money/) for why a bare number here would be an amount nothing
knows the unit of.

:::caution
`options_total` is **written by whoever creates the line**, not maintained by a
rollup. A money rollup is refused by design when either side uses
`money.currencyField` — summing those would add denominations together — and
every catalog amount uses it. That is also how every commerce system works: the
configurator resolves the price and the line freezes it. See
[rollups](/docs/rollups/).
:::

## Rules

A rule reads as one sentence: **when** this slot is this choice, **then** that
slot/choice is required, blocked, hidden, defaulted, or the build is refused.

| `rule_type` | Meaning |
|---|---|
| `requires` | the target must be selected |
| `excludes` | the target cannot be selected — grey it out |
| `hides` | the target slot is not shown at all |
| `sets_default` | the target becomes the pre-selection |
| `validation` | the configuration is refused, with `message` |

`when_value` empty means "any choice in this slot"; `then_value` empty means the
whole slot. The rule's product is `when_modifier`'s product and is not stored a
second time — a duplicate is a second thing that can disagree.

### Evaluating a partial selection

This is the whole engine. It answers, for a selection so far, what is still
selectable and what the build costs — the two questions a configurator screen
asks on every click.

```ts
type Selection = Record<string, string>; // slot id -> choice id

export function resolve(
  slots: Slot[],           // product_modifiers, with their set + choices
  rules: Rule[],           // modifier_rules for this product
  selection: Selection,
  basePrice: number,
) {
  const blocked = new Set<string>();   // choice ids that cannot be picked
  const hidden = new Set<string>();    // slot ids not shown
  const required = new Set<string>();
  const violations: string[] = [];

  const fires = (r: Rule) =>
    r.when_value
      ? selection[r.when_modifier] === r.when_value
      : selection[r.when_modifier] !== undefined;

  // One pass is enough for the rule kinds above: none of them SELECT a value,
  // so no rule can newly fire because another one did. Add a kind that does
  // (an auto-add), and this becomes a fixpoint loop with a cycle guard.
  for (const r of rules) {
    if (!r.active || !fires(r)) continue;
    const targets = r.then_value
      ? [r.then_value]
      : choicesOf(slots, r.then_modifier).map((c) => c.id);

    if (r.rule_type === "excludes") for (const t of targets) blocked.add(t);
    if (r.rule_type === "hides") hidden.add(r.then_modifier);
    if (r.rule_type === "requires") required.add(r.then_modifier);
    if (r.rule_type === "validation") violations.push(r.message);
  }

  // A selection the rules have since forbidden is a violation, not a silent
  // drop: the shopper picked it and has to be told which one to change.
  for (const [slot, choice] of Object.entries(selection)) {
    if (blocked.has(choice)) violations.push(messageFor(rules, slot, choice));
    if (hidden.has(slot)) violations.push(messageFor(rules, slot, choice));
  }
  for (const slot of slots) {
    if (hidden.has(slot.id)) continue;
    const need = slot.is_required || required.has(slot.id);
    if (need && selection[slot.id] === undefined) {
      violations.push(`Choose a ${slot.label ?? slot.set.name}.`);
    }
  }

  // Price. Percentages are all taken against the ORIGINAL base, never against
  // a running total — otherwise two 10% options compound to 21% and the order
  // they were clicked in changes the price.
  const chosen = Object.entries(selection)
    .filter(([slotId]) => !hidden.has(slotId))
    .map(([slotId, choiceId]) => [slotId, choiceById(slots, choiceId)] as const)
    .filter(([, c]) => c !== undefined);

  // A fixed_price choice replaces the base outright, so it is resolved first
  // and the additive ones stack on whatever it left.
  const override = chosen.find(([, c]) => c!.adjustment_type === "fixed_price");
  let total = override ? (override[1]!.price_adjustment ?? 0) : basePrice;

  const lines: { slot: string; label: string; amount: number }[] = [];
  for (const [slotId, c] of chosen) {
    if (c!.adjustment_type === "fixed_price") continue;
    const amount =
      c!.adjustment_type === "percent"
        ? (basePrice * (c!.adjustment_percent ?? 0)) / 100
        : (c!.price_adjustment ?? 0);
    total += amount;
    lines.push({ slot: slotId, label: c!.label, amount });
  }

  return { blocked, hidden, violations, total, lines, code: codeOf(slots, selection) };
}
```

Two properties matter more than the code. **The same function runs on the
storefront and before the write** — a rule enforced only in a form is a rule
some other channel does not have. And **a blocked choice the shopper already
picked is reported, never silently dropped**: telling somebody their build
changed by itself is worse than telling them which part to change.

## Checkout

Adding a configured product to a basket is four writes, in this order:

1. `cart_items` — with `unit_price` (the base), `options_total` and
   `config_code` from `resolve()`.
2. `cart_item_options` — one row per chosen slot, with `label` and
   `price_adjustment` **snapshotted**, so a catalog edit cannot silently
   reprice a basket somebody is looking at.
3. add-on lines — their own `cart_items` rows with `parent` set to (1).
4. at checkout the same rows become `order_items` / `order_item_options`, and
   the option rows copy `component_variant` across so the picker is told what
   to fit without re-reading a catalog that has moved on.

Stock comes off the **components**: for every option row with a
`component_variant`, take `qty × consumes_qty` against that variant's
`inventory_levels` — see [architecture](/docs/architecture/) for where
reservations sit in the order lifecycle.

## A worked example

A gaming laptop with four drive bays, sold in one line.

```
modifier_sets     RAM  (Memory, choice)      SSD (M.2 SSD, choice)   FIN (Finish, choice)
modifier_values   16GB +0 · 32GB +240 (component: RAM-32-STICK ×2) · 64GB +560
                  NONE +0 · 1TB +90 (component: SSD-1TB) · 2TB +190 (component: SSD-2TB)
                  BLK +0 · WHT +30

product_modifiers  Memory        → RAM
                   Drive bay 1   → SSD   (is_required)
                   Drive bay 2   → SSD
                   Drive bay 3   → SSD
                   Drive bay 4   → SSD
                   Finish        → FIN

modifier_rules     when Drive bay 3 = any     excludes  Finish = WHT
                   when Memory     = 64GB     requires  Drive bay 1
```

Six slots, eleven choices, two rules — **nineteen rows**, against 22 500 variant
rows for the same range. Picking 32 GB + 1 TB in bay 1 + black gives
`options_total = 330`, `config_code = RAM32GB/SSD1TB/FINBLK`, and an order that
knows to pull two memory sticks and one 1 TB drive off the shelf.

## See also

- [Templates](/docs/templates/) — the e-commerce vertical this ships in
- [Rollups](/docs/rollups/) — why the options total is not one
- [Money](/docs/money/) — amounts and the currency they are in
- [Unique together](/docs/unique-together/) — the pair rule, and why slots deliberately have none
- [Field conditions](/docs/field-conditions/) — how the admin form hides the adjustment that does not apply
