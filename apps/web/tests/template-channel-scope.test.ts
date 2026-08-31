/**
 * Where a channel decides the currency, a priced thing has to name its channel.
 *
 * The commerce model states the rule itself, in `channels_currency`: "A channel
 * is denominated by one currency. Selling the same catalog in a second currency
 * means a second channel." Everything that carries an amount a shopper is
 * charged or measured against therefore has to be reachable to a channel, or
 * the amount is a number with no unit at the moment it is used — `$75` compared
 * against a euro subtotal, `$6.50` quoted with a euro sign in front of it.
 *
 * Two collections shipped without it: `discounts` (a coupon applied in every
 * channel at one currency's threshold) and `shipping_rates` (a rate zoned by
 * country, priced once, offered to channels that charge in different money).
 * Saleor carries both as channel listings — `VoucherChannelListing` holds
 * `discountValue`/`currency`/`minSpent`, `ShippingMethodChannelListing` holds
 * `price`/`minimumOrderPrice` — and refuses a promotion rule that spans
 * currencies outright (`MULTIPLE_CURRENCIES_NOT_ALLOWED`).
 *
 * WHY NOTHING CAUGHT IT, which is the part worth keeping. Five guards ran over
 * this template and every one of them is structurally blind to it:
 *
 *  - `templates-catalog` proves the template APPLIES. A missing relation
 *    applies perfectly.
 *  - `template-kpis` proves every KPI reference and filter value RESOLVES. No
 *    KPI named a channel-scoped discount, so there was nothing to resolve.
 *  - `template-claims` refuses prose naming a mechanism the schema lacks. The
 *    template's description claims "per-channel publication" and "price lists"
 *    — precisely the two things that DO exist. An absence makes no claim.
 *  - `template-money-denomination` proves an amount NAMES a currency.
 *    `discounts.minimum_amount` passed: the collection has a `currency`
 *    column. That guard cannot ask whether the currency is the one the sale is
 *    actually in — it is one level too shallow for this.
 *  - `ecommerce-model`'s orphan sweep proves every collection is REACHABLE.
 *    `channels` was reachable; four relations point at it.
 *
 * And the reason a naive reachability rule would not have worked either is the
 * finding this file exists to pin: `orders` holds both a `channel` and a
 * `shipping_rate`, so the graph already binds those two — as an OBSERVATION of
 * what happened, not a RULE about what is offered. `product_channel_listings`
 * binds product to channel with the identical shape and the opposite meaning.
 * A structural test that cannot tell those apart calls `shipping_rates` scoped
 * and passes. The last test below holds that distinction still real, because
 * the whole guard collapses to a tautology the day it stops being.
 */
import { describe, expect, test } from "bun:test";
import { TEMPLATES } from "../src/server/templates/catalog";

interface FieldLike {
  name: string;
  type?: string;
  to?: string;
  money?: unknown;
}
interface CollectionLike {
  slug: string;
  fields: FieldLike[];
}

/**
 * The collections that RECORD a sale rather than configure one. They name their
 * channel directly and legitimately, and they may point at anything they used —
 * so they can never stand as proof that the thing they used was scoped.
 */
const TRANSACTIONS = new Set(["carts", "orders"]);

/**
 * Priced collections that deliberately do not resolve to a channel. Each reason
 * has to say what the amount IS, such that no channel decides its currency.
 * Empty since the two founding offenders were fixed, and it stays here because
 * the pair of tests around it is the mechanism: one refuses a new entry, the
 * other refuses a stale one.
 */
const NOT_CHANNEL_SCOPED: Record<string, string> = {};

/** Templates where the channel is what denominates — the only ones this asks of. */
const channelDenominated = (t: { collections: CollectionLike[] }): boolean => {
  const ch = t.collections.find((c) => c.slug === "channels");
  return Boolean(ch?.fields.some((f) => f.name === "currency"));
};

const relationsOf = (c: CollectionLike): string[] =>
  c.fields.filter((f) => (f.type === "relation" || f.type === "relation_many") && f.to).map((f) => f.to as string);

/**
 * What binds `slug` to a channel, or null. A binder is a collection whose row
 * points at BOTH — a listing — and it may not be a transaction, for the reason
 * in the header.
 */
const scopedVia = (
  collections: CollectionLike[],
  slug: string,
  seen: Set<string> = new Set(),
): string | null => {
  if (seen.has(slug)) return null;
  seen.add(slug);
  if (slug === "channels") return "is the channel";
  if (TRANSACTIONS.has(slug)) return "is the transaction";
  const self = collections.find((c) => c.slug === slug);
  if (!self) return null;
  const rels = relationsOf(self);
  if (rels.includes("channels")) return "names its channel";
  const binder = collections.find(
    (c) => !TRANSACTIONS.has(c.slug) && relationsOf(c).includes(slug) && relationsOf(c).includes("channels"),
  );
  if (binder) return `listed by ${binder.slug}`;
  for (const parent of rels) {
    const via = scopedVia(collections, parent, seen);
    if (via) return `via ${parent}`;
  }
  return null;
};

const priced = (c: CollectionLike): boolean => c.fields.some((f) => f.money);

const SWEPT = TEMPLATES.filter((t) => channelDenominated(t as unknown as { collections: CollectionLike[] })).flatMap(
  (t) => (t.collections as unknown as CollectionLike[]).filter(priced).map((c) => ({ templateId: t.id, c })),
);

describe("a priced collection resolves to the channel that denominates it", () => {
  test("every one does, or is listed with the reason it cannot", () => {
    const unscoped: string[] = [];
    for (const { templateId, c } of SWEPT) {
      const key = `${templateId}/${c.slug}`;
      if (key in NOT_CHANNEL_SCOPED) continue;
      const all = TEMPLATES.find((t) => t.id === templateId)!.collections as unknown as CollectionLike[];
      if (!scopedVia(all, c.slug)) {
        unscoped.push(
          `${key}: carries an amount and resolves to no channel — add a channel listing, or list it in NOT_CHANNEL_SCOPED with the reason`,
        );
      }
    }
    expect(unscoped).toEqual([]);
  });

  test("the exception list has not rotted — every entry still exists and is still unscoped", () => {
    const stale: string[] = [];
    for (const [key, why] of Object.entries(NOT_CHANNEL_SCOPED)) {
      const [templateId = "", slug = ""] = key.split("/");
      const t = TEMPLATES.find((x) => x.id === templateId);
      const all = (t?.collections ?? []) as unknown as CollectionLike[];
      const c = all.find((x) => x.slug === slug);
      if (!c) stale.push(`${key}: no such collection — drop the exception`);
      else if (!priced(c)) stale.push(`${key}: carries no amount any more — drop the exception`);
      else if (scopedVia(all, slug)) stale.push(`${key}: is scoped now — drop the exception`);
      else if (why.length < 40) stale.push(`${key}: the reason does not say what the amount is`);
    }
    expect(stale).toEqual([]);
  });

  test("the sweep found priced collections at all — a rule matching nothing proves nothing", () => {
    expect(SWEPT.length).toBeGreaterThanOrEqual(15);
    expect(SWEPT.map(({ c }) => c.slug)).toContain("discounts");
    expect(SWEPT.map(({ c }) => c.slug)).toContain("shipping_rates");
  });

  test("the two that shipped unscoped are scoped by a listing, not by an order", () => {
    // Names the fix rather than just its effect: if someone deletes the listing
    // table and the first test still passes, it passed through `orders`.
    const all = TEMPLATES.find((t) => t.id === "ecommerce")!.collections as unknown as CollectionLike[];
    expect(scopedVia(all, "discounts")).toBe("listed by discount_channel_listings");
    expect(scopedVia(all, "shipping_rates")).toBe("listed by shipping_rate_channel_listings");
  });

  test("an order still binds channel to shipping rate — the edge the rule must keep ignoring", () => {
    // The distinction the whole guard rests on. `orders` points at both, so a
    // reachability rule that counted it would call `shipping_rates` scoped and
    // has done, silently, for as long as both columns existed. If this stops
    // being true the exclusion above is dead weight and the rule got weaker
    // without anyone editing it.
    const all = TEMPLATES.find((t) => t.id === "ecommerce")!.collections as unknown as CollectionLike[];
    const orders = all.find((c) => c.slug === "orders")!;
    expect(relationsOf(orders)).toContain("channels");
    expect(relationsOf(orders)).toContain("shipping_rates");
    expect(TRANSACTIONS.has("orders")).toBe(true);
  });
});
