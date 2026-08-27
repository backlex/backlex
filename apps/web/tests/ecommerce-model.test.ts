import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEMPLATES } from "../src/server/templates/catalog";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * The commerce model, checked behaviourally rather than structurally.
 *
 * Every assertion here corresponds to a defect the template actually shipped
 * with, and each one shared a cause: the schema declared a capability and left
 * out the one link that made it real, so nothing failed and nothing worked.
 * A choice could be selected with nothing behind it; a filter named a value
 * the column could not hold; a number the operator was told to keep in step
 * had no keeper. None of them had a test, which is why they lasted.
 *
 * The structural guards live where they belong — `templates-catalog` proves
 * the whole thing applies, `template-kpis` proves every KPI reference AND every
 * filter value resolves, `templates-layout` proves the forms. This file proves
 * the model does its job once the tables exist.
 */
describe("ecommerce model", () => {
  let h: TestHarness;

  const get = async (path: string) => {
    const res = await h.fetch(`/api/items/${path}`);
    return (await res.json()) as { data: Record<string, unknown>[] };
  };
  /** Single item by id. `?id=…` is NOT a filter — the list endpoint takes
   *  `filter={"col":{"_eq":…}}` — so reading one row goes through this. */
  const one = async (slug: string, id: unknown) => {
    const res = await h.fetch(`/api/items/${slug}/${id}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  };
  const where = (o: unknown) => `filter=${encodeURIComponent(JSON.stringify(o))}`;
  const post = (slug: string, body: unknown) =>
    h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const patch = (slug: string, id: string, body: unknown) =>
    h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const applied = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    expect(applied.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("a variant is resolvable from the option values it selects", async () => {
    // The defect: `product_options` and `product_option_values` existed and
    // nothing pointed at them, so a variant's identity was the free text in its
    // `title`. A storefront could not turn "Size = S, Colour = Black" into a
    // sellable unit, and no check could find a missing combination.
    const values = await get("product_option_values?limit=100");
    const s = values.data.find((v) => v.value === "S")!;
    const black = values.data.find((v) => v.value === "Black")!;
    expect(s).toBeTruthy();
    expect(black).toBeTruthy();

    const links = await get("variant_option_values?limit=200");
    const variantsWith = (valueId: unknown) =>
      new Set(links.data.filter((l) => l.value === valueId).map((l) => l.variant));

    const both = [...variantsWith(s.id)].filter((v) => variantsWith(black.id).has(v));
    expect(both).toHaveLength(1);

    const variants = await get("product_variants?limit=100");
    const resolved = variants.data.find((v) => v.id === both[0]);
    expect(resolved?.sku).toBe("TEE-001-S-BLK");
  });

  test("available is generated from on hand minus committed, and cannot be written", async () => {
    // The defect: `available` was a third integer with a hint telling the
    // operator to keep all three consistent by hand. It is a definition, not a
    // judgement — so the database owns it now.
    const variants = await get("product_variants?limit=10");
    const locations = await get("locations?limit=10");

    const made = await post("inventory_levels", {
      variant: variants.data[0]!.id,
      location: locations.data[0]!.id,
      on_hand: 10,
      committed: 4,
    });
    expect([200, 201]).toContain(made.status);
    const { data: level } = (await made.json()) as { data: { id: string } };
    // Read back rather than trusting the create body: a write returns the row
    // it was given, and a generated column is only known once the database has
    // it.
    expect((await one("inventory_levels", level.id)).available).toBe(6);

    // Still generated after an edit, and still refused as an input.
    const bumped = await patch("inventory_levels", level.id, { committed: 9 });
    expect(bumped.status).toBe(200);
    expect((await one("inventory_levels", level.id)).available).toBe(1);

    const written = await post("inventory_levels", {
      variant: variants.data[0]!.id,
      location: locations.data[0]!.id,
      on_hand: 5,
      committed: 0,
      available: 999,
    });
    expect(written.status).toBe(422);
  });

  test("a variant's price carries its currency, like every other amount", async () => {
    // The defect: `products.price` was a money field denominated by the row's
    // own currency and `product_variants.price` — the number that actually
    // reaches a basket — was a bare float with no currency column at all.
    const variants = await get("product_variants?limit=10");
    const tee = variants.data.find((v) => v.sku === "TEE-001-S-BLK")!;
    expect(tee.price).toEqual({ amount: 25, currency: "USD" });
    expect(tee.cost).toEqual({ amount: 9, currency: "USD" });
  });

  test("an order's lifecycle is its own column, and cancelling never touches payment", async () => {
    // The defect this is the fix for: cancellation was a value of the PAYMENT
    // column (`voided`), so an order could not be both paid and cancelled, and
    // every report that meant "exclude cancelled" had to name a payment value.
    const customers = await get("customers?limit=5");
    const created = await post("orders", {
      customer: customers.data[0]!.id,
      email: "cancelled@example.com",
      state: "open",
      status: "paid",
      subtotal: 1000,
      total: 1000,
      currency: "USD",
      placed_at: Date.now(),
    });
    expect([200, 201]).toContain(created.status);
    const { data: order } = (await created.json()) as { data: { id: string } };

    const cancelled = await patch("orders", order.id, {
      state: "cancelled",
      cancel_reason: "customer",
      cancelled_at: Date.now(),
    });
    expect(cancelled.status).toBe(200);
    const body = (await cancelled.json()) as { data: { state: string; status: string } };
    // Cancelled, and still paid — which is the true state of a refund-pending
    // order and was impossible to express before.
    expect(body.data.state).toBe("cancelled");
    expect(body.data.status).toBe("paid");
  });

  test("a cancelled order is out of revenue and in the cancelled count", async () => {
    // End-to-end proof for the filter itself: the previous test left exactly one
    // cancelled order, placed now, worth 1000 USD. Both KPIs run over a window
    // around now, which the seeded January samples fall outside of.
    const now = Date.now();
    const day = 86_400_000;
    const run = async (slug: string) => {
      const res = await h.fetch(
        `/api/admin/kpis/${slug}/run?from=${now - day}&to=${now + day}`,
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        data: {
          point: { value: number | null } | null;
          rows: { label?: string; value: number | null }[] | null;
        };
      };
    };

    const placed = await run("orders-placed");
    expect(placed.data.point?.value ?? 0).toBe(0);

    const revenue = await run("net-revenue");
    // Grouped by currency, so a USD row would carry the 1000 if it counted.
    const usd = revenue.data.rows?.find((r) => r.label === "USD");
    expect(usd?.value ?? 0).toBe(0);

    const cancelled = await run("cancelled-orders");
    expect(cancelled.data.point?.value).toBe(1);
  });

  test("a cart carries its lines, and its item count is kept from them", async () => {
    // The defect: `carts` held an item count and a subtotal and nothing else —
    // so the bundled recovery email could not name what was left behind, and
    // the count was a number somebody had to remember to update.
    const carts = await get("carts?limit=5");
    expect(carts.data).toHaveLength(1);
    const cart = carts.data[0]!;

    const lines = await get(`cart_items?${where({ cart: { _eq: cart.id } })}&limit=50`);
    expect(lines.data.length).toBeGreaterThan(0);
    const qty = lines.data.reduce((n, l) => n + Number(l.qty ?? 0), 0);
    expect(cart.item_count).toBe(qty);

    // And it follows a new line rather than going stale.
    const products = await get("products?limit=5");
    const added = await post("cart_items", {
      cart: cart.id,
      product: products.data[0]!.id,
      title: "Extra line",
      qty: 3,
      unit_price: 5,
    });
    expect([200, 201]).toContain(added.status);
    expect((await one("carts", cart.id)).item_count).toBe(qty + 3);
  });

  test("a product's rating is kept from its approved reviews only", async () => {
    const products = await get("products?limit=5");
    const tee = products.data.find((p) => p.sku === "TEE-001")!;
    // One approved 5-star review ships as a sample.
    expect(tee.review_count).toBe(1);
    expect(Number(tee.rating)).toBe(5);

    // A pending review is not a rating — that default is the only thing keeping
    // unmoderated text off the storefront, and it must keep the number off too.
    const pending = await post("reviews", { product: tee.id, rating: 1, title: "Nope", body: "..." });
    expect([200, 201]).toContain(pending.status);
    const again = await one("products", tee.id);
    expect(again.review_count).toBe(1);
    expect(Number(again.rating)).toBe(5);
  });

  test("tax is recorded per line, because one order mixes rates", async () => {
    const lines = await get("order_items?limit=20");
    expect(lines.data.length).toBeGreaterThan(0);
    for (const l of lines.data) {
      expect(l).toHaveProperty("tax_rate");
      expect(l).toHaveProperty("tax_amount");
      // Every amount on a line is MONEY — the order it belongs to is
      // denominated, so the lines that make up its total have to be too, or
      // `sum` over them adds €85 to $100 and answers 185.5 of nothing.
      const unit = l.unit_price as unknown as { amount: number; currency: string };
      const total = l.line_total as unknown as { amount: number; currency: string };
      const tax = l.tax_amount as unknown as { amount: number; currency: string } | null;
      expect(typeof unit.currency).toBe("string");
      // The computed column still works alongside the new ones, and keeps the
      // unit rather than handing back a bare count of minor units.
      expect(total.amount).toBe(Number(l.qty) * unit.amount);
      expect(total.currency).toBe(unit.currency);
      if (tax) expect(tax.currency).toBe(unit.currency);
    }
  });

  test("a partly-shipped order can say which line was in the box", async () => {
    const shipped = await get("fulfillment_items?limit=20");
    expect(shipped.data.length).toBeGreaterThan(0);
    const items = await get("order_items?limit=20");
    const ids = new Set(items.data.map((i) => i.id));
    for (const f of shipped.data) {
      expect(ids.has(f.order_item)).toBe(true);
      expect(Number(f.qty)).toBeGreaterThan(0);
    }
  });

  test("every collection the model needs is reachable from another one", () => {
    // The structural version of D1 and D9: a collection nothing points at is
    // either a root (a catalog, a setting) or a modelling hole. This lists the
    // roots explicitly, so a NEW orphan fails here instead of shipping as a
    // table with no way in.
    const tpl = TEMPLATES.find((t) => t.id === "ecommerce")!;
    const targets = new Set<string>();
    for (const c of tpl.collections) {
      for (const f of c.fields) {
        if ((f.type === "relation" || f.type === "relation_many") && f.to) targets.add(f.to);
        if (f.rollup?.from) targets.add(f.rollup.from);
      }
    }
    // Roots: things an operator or an outside system creates directly, and
    // ledgers whose whole job is to be written and read, never pointed at.
    const ROOTS = new Set([
      "carts", "orders", "fulfillments", "returns", "reviews", "subscriptions",
      "inventory_levels", "inventory_reservations", "stock_movements",
      "product_channel_listings", "product_categories", "product_collections",
      "related_products", "variant_option_values", "product_attributes",
      "prices", "order_discounts", "order_items", "return_items",
      "fulfillment_items", "wishlist_items", "gift_card_transactions",
      "discount_rules", "shipping_rate_rules", "modifier_values",
      "cart_items", "redirects", "translations", "consignments", "transactions",
    ]);
    const orphans = tpl.collections
      .map((c) => c.slug)
      .filter((s) => !targets.has(s) && !ROOTS.has(s));
    expect(orphans).toEqual([]);
  });
});
