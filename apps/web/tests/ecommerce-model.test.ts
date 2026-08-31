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

  test("a configured line totals base plus options, and an unconfigured one still totals", async () => {
    // The defect: `line_total` was `qty * unit_price` while the chosen options
    // were free text in a `tags` column, so a configured unit's price was
    // whatever a storefront happened to fold into `unit_price` — the breakdown
    // could not be shown back and the figure could not be rechecked.
    //
    // Adding the options to the generated column is only half of it. A bare
    // `unit_price + options_total` is NULL for every line that configures
    // nothing, so the ordinary lines — the overwhelming majority — would have
    // silently lost their total the day this column arrived. Hence COALESCE,
    // and hence the second half of this test.
    const orders = await get("orders?limit=5");
    const products = await get("products?limit=5");
    const variants = await get("product_variants?limit=10");

    const configured = await post("order_items", {
      order: orders.data[0]!.id,
      product: products.data[0]!.id,
      variant: variants.data[0]!.id,
      title: "Classic Tee — S / Black",
      qty: 2,
      unit_price: 25,
      options_total: 5,
      currency: "USD",
    });
    expect([200, 201]).toContain(configured.status);
    const { data: line } = (await configured.json()) as { data: { id: string } };
    // Read back — a generated column is only known once the database has it.
    expect((await one("order_items", line.id)).line_total).toEqual({ amount: 60, currency: "USD" });

    const plain = await post("order_items", {
      order: orders.data[0]!.id,
      product: products.data[0]!.id,
      title: "Nothing configured",
      qty: 3,
      unit_price: 10,
      currency: "USD",
    });
    expect([200, 201]).toContain(plain.status);
    const { data: bare } = (await plain.json()) as { data: { id: string } };
    expect((await one("order_items", bare.id)).line_total).toEqual({ amount: 30, currency: "USD" });

    // Generated, so it is refused as input — like every other derived amount.
    expect((await patch("order_items", line.id, { line_total: 1 })).status).toBe(422);
  });

  test("one product carries the same option set in more than one slot", async () => {
    // The case a per-product option list cannot express at all. A machine with
    // four drive bays prices and stocks each bay on its own, so the four are
    // four SLOTS over ONE shared set — not one option picked four times, and
    // not four duplicated lists that drift apart on the first price change.
    // Uniqueness on (product, set) would forbid exactly this, which is why
    // there is none, and why that absence needs a test to stay deliberate.
    const products = await get("products?limit=5");
    const machine = products.data[0]!.id;

    const set = await post("modifier_sets", {
      name: "M.2 SSD",
      code: "SSD",
      input_type: "choice",
      min_select: 0,
      max_select: 1,
      active: true,
    });
    expect([200, 201]).toContain(set.status);
    const { data: ssd } = (await set.json()) as { data: { id: string } };

    for (const bay of [1, 2, 3, 4]) {
      const made = await post("product_modifiers", {
        product: machine,
        modifier_set: ssd.id,
        label: `Drive bay ${bay}`,
        position: 100 + bay,
      });
      expect([200, 201]).toContain(made.status);
    }

    const slots = await get(
      `product_modifiers?${where({ product: { _eq: machine }, modifier_set: { _eq: ssd.id } })}&limit=20`,
    );
    expect(slots.data).toHaveLength(4);
    // Four rows over one set, each separately labelled — that is the whole point.
    expect(new Set(slots.data.map((s) => s.label)).size).toBe(4);
  });

  test("a chosen option is a reference, and names the component it consumes", async () => {
    // The defect: `modifier_values` was reachable from NOTHING — the
    // reachability test at the bottom of this file listed it among the roots,
    // which is how an orphan hides. A choice could be defined and priced, a
    // storefront could show it, and the line that was sold recorded a
    // name/value pair of free text. So the price could not be recomputed, the
    // upgrade could not be counted, and the part it consumed could not be taken
    // off the shelf.
    const products = await get("products?limit=5");
    const variants = await get("product_variants?limit=10");
    const orders = await get("orders?limit=5");
    const component = variants.data[1]!;

    const set = await post("modifier_sets", {
      name: "Memory", code: "RAM", input_type: "choice", min_select: 1, max_select: 1, active: true,
    });
    const { data: ram } = (await set.json()) as { data: { id: string } };

    const upgrade = await post("modifier_values", {
      modifier_set: ram.id,
      label: "32 GB",
      code: "32GB",
      adjustment_type: "fixed_amount",
      price_adjustment: 240,
      currency: "USD",
      // The half BigCommerce's modifiers deliberately cannot do: a choice that
      // consumes a real, stocked unit.
      component_variant: component.id,
      consumes_qty: 2,
      position: 1,
      active: true,
    });
    expect([200, 201]).toContain(upgrade.status);
    const { data: gb32 } = (await upgrade.json()) as { data: { id: string } };

    const slot = await post("product_modifiers", {
      product: products.data[0]!.id, modifier_set: ram.id, label: "Memory", is_required: true, position: 200,
    });
    const { data: memorySlot } = (await slot.json()) as { data: { id: string } };

    const sold = await post("order_items", {
      order: orders.data[0]!.id, product: products.data[0]!.id,
      title: "Configured machine", qty: 1, unit_price: 1200, options_total: 240,
      currency: "USD", config_code: "TEE/32GB",
    });
    const { data: soldLine } = (await sold.json()) as { data: { id: string } };

    const chosen = await post("order_item_options", {
      line: soldLine.id,
      modifier: memorySlot.id,
      value: gb32.id,
      label: "32 GB",
      qty: 1,
      price_adjustment: 240,
      currency: "USD",
      component_variant: component.id,
      position: 1,
    });
    expect([200, 201]).toContain(chosen.status);

    // The chain the free-text column could not make: line → slot → choice →
    // the stocked unit a picker has to fit.
    const rows = await get(`order_item_options?${where({ line: { _eq: soldLine.id } })}&limit=10`);
    expect(rows.data).toHaveLength(1);
    const row = rows.data[0]!;
    expect(row.value).toBe(gb32.id);
    expect(row.price_adjustment).toEqual({ amount: 240, currency: "USD" });
    expect(row.component_variant).toBe(component.id);

    // And the line's own total agrees with what its options came to — the
    // question "does the price match the build" now HAS an answer.
    const sum = rows.data.reduce(
      (acc, r) => acc + ((r.price_adjustment as { amount: number } | null)?.amount ?? 0) * Number(r.qty ?? 1),
      0,
    );
    expect((await one("order_items", soldLine.id)).options_total).toEqual({ amount: sum, currency: "USD" });
  });

  test("available is generated from on hand minus committed, and NEITHER can be written", async () => {
    // The defect: `available` was a third integer with a hint telling the
    // operator to keep all three consistent by hand. It is a definition, not a
    // judgement — so the database owns it now.
    //
    // `committed` used to be typed in here, which was the second half of the
    // same defect: its own hint said it was "the sum of the open reservations
    // against this level" and nothing summed them, so a held reservation left
    // `available` reporting reserved units as sellable. It is a rollup now, so
    // the only way to move it is to reserve something.
    const variants = await get("product_variants?limit=10");
    const locations = await get("locations?limit=10");

    const made = await post("inventory_levels", {
      product: variants.data[0]!.product,
      variant: variants.data[0]!.id,
      location: locations.data[1]!.id,
      on_hand: 10,
    });
    expect([200, 201]).toContain(made.status);
    const { data: level } = (await made.json()) as { data: { id: string } };
    // Read back rather than trusting the create body: a write returns the row
    // it was given, and a generated column is only known once the database has
    // it.
    expect((await one("inventory_levels", level.id)).available).toBe(10);

    // Four held against it, and both derived numbers follow.
    const held = await post("inventory_reservations", {
      level: level.id,
      variant: variants.data[0]!.id,
      location: locations.data[1]!.id,
      qty: 4,
      status: "held",
    });
    expect([200, 201]).toContain(held.status);
    const reserved = await one("inventory_levels", level.id);
    expect(reserved.committed).toBe(4);
    expect(reserved.available).toBe(6);

    // Both are refused as inputs.
    expect((await patch("inventory_levels", level.id, { committed: 9 })).status).toBe(422);
    expect(
      (
        await post("inventory_levels", {
          variant: variants.data[0]!.id,
          location: locations.data[2]!.id,
          on_hand: 5,
          available: 999,
        })
      ).status,
    ).toBe(422);
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
      const options = l.options_total as unknown as { amount: number } | null;
      expect(typeof unit.currency).toBe("string");
      // The computed column still works alongside the new ones, and keeps the
      // unit rather than handing back a bare count of minor units. The base and
      // the configured half are separate columns and one total — a line that
      // configures nothing contributes 0 here rather than NULLing the total.
      expect(total.amount).toBe(Number(l.qty) * (unit.amount + (options?.amount ?? 0)));
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

  test("a discount is listed once per channel, and the second row is refused", async () => {
    // The defect: a discount had no channel scope at all, so "web only" could
    // not be said and `discounts.code` being UNIQUE meant it could not be said
    // by cloning the row either — the same coupon code cannot exist twice.
    const discounts = await get("discounts?limit=10");
    const channels = await get("channels?limit=10");
    const pos = channels.data.find((c) => c.code === "pos-sf")!;
    const welcome = discounts.data.find((d) => d.code === "WELCOME10")!;

    // Seeded on the two web channels and deliberately not on the counter.
    const listed = await get(`discount_channel_listings?${where({ discount: { _eq: welcome.id } })}&limit=10`);
    expect(listed.data).toHaveLength(2);
    expect(listed.data.some((l) => l.channel === pos.id)).toBe(false);

    const first = await post("discount_channel_listings", {
      discount: welcome.id,
      channel: pos.id,
      value: 10,
      currency: "USD",
    });
    expect([200, 201]).toContain(first.status);
    const again = await post("discount_channel_listings", {
      discount: welcome.id,
      channel: pos.id,
      value: 5,
      currency: "USD",
    });
    expect(again.status).toBe(409);
  });

  test("a per-channel threshold is its own number in that currency, never a conversion", async () => {
    // The whole reason this is a table rather than a `channel` column. The
    // model's own rule is that a channel is denominated by ONE currency, so a
    // single `minimum_amount` on the discount was a dollar figure being
    // compared against a euro subtotal — with nothing anywhere saying so.
    const discounts = await get("discounts?limit=10");
    const free = discounts.data.find((d) => d.name === "Free shipping over $75")!;
    const rows = await get(`discount_channel_listings?${where({ discount: { _eq: free.id } })}&limit=10`);
    const amounts = rows.data.map((r) => r.minimum_amount as { amount: number; currency: string });
    expect(amounts.map((a) => `${a.amount} ${a.currency}`).sort()).toEqual(["70 EUR", "75 USD"]);

    // And the amounts are genuinely denominated rather than two floats that
    // happen to sit beside a currency label: summing across them is refused,
    // which is the only difference that matters downstream.
    const summed = await h.fetch(`/api/items/discount_channel_listings/aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agg: "sum", field: "minimum_amount" }),
    });
    expect(summed.status).toBe(422);
    // For the RIGHT reason: a 422 from a mistyped field name would satisfy the
    // line above while proving nothing.
    expect(JSON.stringify(await summed.json())).toMatch(/different currency per row/);

    // Grouped by currency it answers, and the two totals are the two channels'
    // thresholds — which is the shape a report has to read them in.
    const perCurrency = await h.fetch(`/api/items/discount_channel_listings/aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agg: "sum", field: "minimum_amount", groupBy: "currency" }),
    });
    expect(perCurrency.status).toBe(200);
    const totals = ((await perCurrency.json()) as { data: { label: string; value: number }[] }).data;
    expect(new Map(totals.map((t) => [t.label, Number(t.value)]))).toEqual(
      new Map([["USD", 75], ["EUR", 70]]),
    );
  });

  test("a shipping rate is priced per channel, and the euro price is not the dollar one", async () => {
    // Same defect one table over: a zone can span channels that charge in
    // different money, so a rate offered in both had one price and one currency
    // for both of them.
    const rates = await get("shipping_rates?limit=10");
    const standard = rates.data.find((r) => r.name === "Standard")!;
    const rows = await get(`shipping_rate_channel_listings?${where({ rate: { _eq: standard.id } })}&limit=10`);
    const prices = rows.data.map((r) => r.price as { amount: number; currency: string });
    expect(prices.map((p) => `${p.amount} ${p.currency}`).sort()).toEqual(["6.5 USD", "7.5 EUR"]);
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
      "discount_rules", "shipping_rate_rules", "modifier_rules",
      "cart_items", "redirects", "translations", "consignments", "transactions",
      "discount_channel_listings", "shipping_rate_channel_listings",
      "cart_item_options", "order_item_options", "product_addons",
    ]);
    const orphans = tpl.collections
      .map((c) => c.slug)
      .filter((s) => !targets.has(s) && !ROOTS.has(s));
    expect(orphans).toEqual([]);
  });
});
