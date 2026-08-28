/**
 * An amount that flows into a denominated amount must itself be denominated.
 *
 * The commerce model protected its TOTALS and left the lines that make them up
 * as bare numbers. That is not a smaller version of the same thing: a `money`
 * column refuses `sum` across currencies and refuses a comparison that does not
 * say which currency it means, and a `number` column refuses neither. So
 * `sum(orders.total)` answered `422 — "total" holds a different currency per
 * row` while `sum(order_items.unit_price)` cheerfully added €85 to $100 and
 * answered `185.5`, of nothing.
 *
 * Nothing typechecks that. A template is data: `money("unit_price")` — which is
 * `type: "number"`, the deliberate fallback for a collection with no currency
 * column — and `moneyIn("unit_price")` differ by two characters and by whether
 * every figure downstream is trustworthy.
 *
 * The rule enforced here is mechanical: a collection carrying a bare decimal
 * amount may not hold a `relation` to a collection that IS denominated. If the
 * parent knows what currency it is in, the child has to as well, and the fix is
 * always the same — add the `currency` column and switch `money()` to
 * `moneyIn()`, exactly as `product_variants.price` was fixed one release
 * earlier for the same reason.
 *
 * `KNOWN_UNDENOMINATED` started as the same defect elsewhere — 17 collections
 * across 9 other verticals — and is empty now that all of them are fixed. The
 * set stays because the pair of tests around it is the mechanism: one refuses a
 * NEW offender, the other refuses a stale entry, so the list can neither grow
 * back nor keep an entry after it is fixed. Denominating `appointments/packages`
 * is what made `appointments/package_purchases` an offender — a cascade nobody
 * would have looked for, and the guard named it.
 */
import { describe, expect, test } from "bun:test";
import { TEMPLATES } from "../src/server/templates/catalog";

interface Field {
  name: string;
  type: string;
  interface?: string;
  to?: string;
  computed?: unknown;
}

/** `money()` in the template DSL — a plain float with a decimal editor. */
const isBareAmount = (f: Field): boolean =>
  f.type === "number" && f.interface === "decimal";

/** A collection is denominated when it carries the `currency` column that
 *  `moneyIn()` reads each row's unit from. */
const isDenominated = (fields: Field[]): boolean => fields.some((f) => f.name === "currency");

/**
 * Every `<template>/<collection>` that still holds a bare amount beside a
 * denominated parent. Measured, not guessed — regenerate by deleting an entry
 * and reading the failure.
 */
const KNOWN_UNDENOMINATED = new Set<string>([
  // Empty, and that is the point of keeping it: the seventeen collections
  // across nine other verticals that were listed here on 2026-08-27 have all
  // been denominated. A new entry appearing means a template regressed, and the
  // first test below refuses it rather than letting the list grow back.
]);

const offenders = (): string[] => {
  const found: string[] = [];
  for (const t of TEMPLATES) {
    const denominated = new Set(
      t.collections.filter((c) => isDenominated((c.fields ?? []) as Field[])).map((c) => c.slug),
    );
    for (const c of t.collections) {
      const fields = (c.fields ?? []) as Field[];
      const bare = fields.filter(isBareAmount);
      if (bare.length === 0) continue;
      const parents = fields.filter((f) => f.type === "relation" && f.to && denominated.has(f.to));
      if (parents.length > 0) found.push(`${t.id}/${c.slug}`);
    }
  }
  return found;
};

describe("template money: an amount beside a denominated parent carries its own currency", () => {
  test("no NEW collection joins the undenominated list", () => {
    const unexpected = offenders().filter((k) => !KNOWN_UNDENOMINATED.has(k));
    expect(unexpected).toEqual([]);
  });

  test("the allowlist has no stale entries — a fixed one must be struck off", () => {
    const live = new Set(offenders());
    const stale = [...KNOWN_UNDENOMINATED].filter((k) => !live.has(k));
    expect(stale).toEqual([]);
  });

  test("the commerce model has no undenominated amount left anywhere", () => {
    const ecommerce = TEMPLATES.find((t) => t.id === "ecommerce");
    expect(ecommerce).toBeDefined();
    const bare: string[] = [];
    for (const c of ecommerce?.collections ?? []) {
      for (const f of ((c.fields ?? []) as Field[]).filter(isBareAmount)) {
        bare.push(`${c.slug}.${f.name}`);
      }
    }
    expect(bare).toEqual([]);
  });

  test("every money column in the commerce model has the currency column it names", () => {
    const ecommerce = TEMPLATES.find((t) => t.id === "ecommerce");
    const missing: string[] = [];
    for (const c of ecommerce?.collections ?? []) {
      const fields = (c.fields ?? []) as Field[];
      const money = fields.filter((f) => f.type === "money");
      if (money.length === 0) continue;
      if (!isDenominated(fields)) missing.push(`${c.slug} (${money.map((m) => m.name).join(", ")})`);
    }
    expect(missing).toEqual([]);
  });

  test("a computed amount over money columns is money, not a bare number of minor units", () => {
    // `qty * unit_price` on minor-unit integers is minor units. Declared with
    // `computedNum` it reads back as `8500` beside a total of `€85.00`, which
    // is the silent wrongness the money type exists to end.
    const ecommerce = TEMPLATES.find((t) => t.id === "ecommerce");
    const wrong: string[] = [];
    for (const c of ecommerce?.collections ?? []) {
      const fields = (c.fields ?? []) as Field[];
      const moneyNames = new Set(fields.filter((f) => f.type === "money").map((f) => f.name));
      for (const f of fields) {
        const formula = (f.computed as { formula?: string } | undefined)?.formula;
        if (!formula || f.type === "money") continue;
        if ([...moneyNames].some((m) => new RegExp(`\\b${m}\\b`).test(formula))) {
          wrong.push(`${c.slug}.${f.name} = "${formula}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
