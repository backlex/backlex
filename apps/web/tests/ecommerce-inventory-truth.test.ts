/**
 * The commerce model's inventory numbers have to be what the model says they
 * are.
 *
 * Two hints asserted an invariant nothing maintained, and both were reachable
 * from the admin UI as plain editable integers:
 *
 *  - `inventory_levels.committed` — "Committed is the sum of the open
 *    reservations against this level." It was an `int`. A held reservation for
 *    7 left it at 0, and `available` — a GENERATED column, which reads as
 *    authoritative precisely because it cannot be typed — went on reporting the
 *    reserved units as sellable. That is an oversell.
 *  - `products.stock` — "Total stock is a roll-up for reporting." It was an
 *    `int`, and shipped seeded at 120 for a product whose variants held 90.
 *
 * The missing piece for the first was structural, not arithmetic:
 * `inventory_reservations` named a variant and a location, an inventory level
 * named the same pair, and nothing joined them — so no rollup could exist. The
 * same shape as the `variant_option_values` link one release earlier.
 *
 * The second looked as though it could not be a rollup, and for one route it
 * cannot: summing the VARIANT would be a rollup of a rollup, which does not
 * refresh — the write path restates a parent from its children with a direct
 * UPDATE that never re-enters the write path to restate the grandparent.
 * Measured, a level moved 60 → 85, the variant followed and the product stayed
 * at 60. The route that does work is reaching PAST the variant: with a
 * denormalised `inventory_levels.product`, the product sums `on_hand` — a plain
 * column — so the two are siblings over one child rather than a chain, and the
 * write path refreshes every parent that rolls up from a collection, not the
 * first one it finds.
 *
 * Which leaves the model with one number anyone types, `on_hand`, and every
 * other figure derived from it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { TEMPLATES } from "../src/server/templates/catalog";
import { TEMPLATE_KPIS } from "../src/server/templates/kpis";

interface Level {
  id: string;
  variant: string;
  location: string;
  on_hand: number;
  committed: number;
  available: number;
}

describe("commerce inventory: the numbers are what the model says they are", () => {
  let h: TestHarness;

  const get = async <T>(path: string): Promise<T> => {
    const res = await h.fetch(`/api/items/${path}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: T }).data;
  };
  const write = (path: string, body: unknown, method = "POST") =>
    h.fetch(`/api/items/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const apply = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    expect(apply.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("the seeded held reservation is already in `committed`", async () => {
    // The template ships one reservation of 1, held. Before the link existed
    // every seeded level read committed=0.
    const levels = await get<Level[]>("inventory_levels?limit=20");
    const withHold = levels.filter((l) => l.committed > 0);
    expect(withHold.length).toBe(1);
    expect(withHold[0]?.committed).toBe(1);
    expect(withHold[0]?.available).toBe((withHold[0]?.on_hand ?? 0) - 1);
  });

  test("a new hold moves `committed` and shrinks `available`", async () => {
    const [level] = await get<Level[]>("inventory_levels?limit=1");
    expect(level).toBeDefined();
    const before = level as Level;

    const res = await write("inventory_reservations", {
      level: before.id,
      variant: before.variant,
      location: before.location,
      qty: 7,
      status: "held",
    });
    expect(res.status).toBe(201);
    const { data: held } = (await res.json()) as { data: { id: string } };

    const after = await get<Level>(`inventory_levels/${before.id}`);
    expect(after.committed).toBe(before.committed + 7);
    expect(after.available).toBe(before.on_hand - after.committed);

    // Releasing gives the units back — the rollup filters on `held`.
    expect((await write(`inventory_reservations/${held.id}`, { status: "released" }, "PATCH")).status).toBe(200);
    const released = await get<Level>(`inventory_levels/${before.id}`);
    expect(released.committed).toBe(before.committed);
    expect(released.available).toBe(before.on_hand - before.committed);
  });

  test("a reservation that names no level is refused", async () => {
    const [level] = await get<Level[]>("inventory_levels?limit=1");
    const res = await write("inventory_reservations", {
      variant: (level as Level).variant,
      location: (level as Level).location,
      qty: 1,
      status: "held",
    });
    // Without the link there is nothing for `committed` to be derived from,
    // which is exactly the hole this closed.
    expect(res.status).toBe(422);
  });

  test("`committed` cannot be typed in", async () => {
    const [level] = await get<Level[]>("inventory_levels?limit=1");
    const res = await write(`inventory_levels/${(level as Level).id}`, { committed: 999 }, "PATCH");
    expect(res.status).toBe(422);
  });

  test("every product's stock is the total of its own levels, straight after the seed", async () => {
    // Seeding writes rows wholesale and bypasses the per-write refresh, so the
    // template's own post-seed rollup pass is what has to have run. Computed
    // from the levels rather than hardcoded, so it stays true whatever the
    // sample quantities become.
    const levels = await get<(Level & { product: string })[]>("inventory_levels?limit=200");
    const products = await get<{ id: string; stock: number }[]>("products?limit=100");
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      const expected = levels
        .filter((l) => l.product === p.id)
        .reduce((n, l) => n + l.on_hand, 0);
      expect({ id: p.id, stock: p.stock }).toEqual({ id: p.id, stock: expected });
    }
  });

  test("a level naming no product is refused", async () => {
    // The link is what makes `products.stock` derivable at all; a level that
    // skips it would be stock the product cannot see, which is the silent
    // shape the whole file exists to stop.
    const variants = await get<{ id: string }[]>("product_variants?limit=1");
    const locations = await get<{ id: string }[]>("locations?limit=3");
    const res = await write("inventory_levels", {
      variant: (variants[0] as { id: string }).id,
      location: (locations[2] as { id: string }).id,
      on_hand: 5,
    });
    expect(res.status).toBe(422);
  });

  test("`stock` cannot be typed in", async () => {
    const [product] = await get<{ id: string }[]>("products?limit=1");
    const res = await write(`products/${(product as { id: string }).id}`, { stock: 999 }, "PATCH");
    expect(res.status).toBe(422);
  });

  test("a level write carries all the way up — variant AND product follow", async () => {
    // The regression this pins: `inventory_quantity` followed and `stock` did
    // not, because the product summed the VARIANT (itself a rollup) and a
    // rollup of a rollup never refreshes — the write path restates a parent
    // with a direct UPDATE that does not re-enter it. Measured then: a level
    // moved 60 → 85, the variant followed, the product stayed at 60. Reaching
    // past the variant to `on_hand` makes the two siblings over one child, and
    // the refresh restates every parent that rolls up from that collection.
    const [level] = await get<(Level & { product: string })[]>("inventory_levels?limit=1");
    const before = level as Level & { product: string };
    const variantBefore = await get<{ inventory_quantity: number }>(
      `product_variants/${before.variant}`,
    );
    const productBefore = await get<{ stock: number }>(`products/${before.product}`);

    expect((await write(`inventory_levels/${before.id}`, { on_hand: before.on_hand + 25 }, "PATCH")).status).toBe(200);

    const variantAfter = await get<{ inventory_quantity: number }>(`product_variants/${before.variant}`);
    const productAfter = await get<{ stock: number }>(`products/${before.product}`);
    expect(variantAfter.inventory_quantity).toBe(variantBefore.inventory_quantity + 25);
    expect(productAfter.stock).toBe(productBefore.stock + 25);
  });

  test("no field in the commerce model calls itself a roll-up without being one", () => {
    const ecommerce = TEMPLATES.find((t) => t.id === "ecommerce");
    const claims: string[] = [];
    for (const c of ecommerce?.collections ?? []) {
      const fields = (c.fields ?? []) as {
        name: string;
        type: string;
        rollup?: unknown;
        computed?: unknown;
        description?: string;
      }[];
      const derived = new Set(
        fields.filter((f) => f.rollup || f.computed).map((f) => f.name),
      );
      for (const f of fields) {
        const text = String(f.description ?? "");
        // A presentational hint names the field it explains via its own key,
        // e.g. `hint("products_stock", …)` sits above `stock`.
        const target = f.name.startsWith(`${c.slug}_`) ? f.name.slice(c.slug.length + 1) : f.name;
        if (/roll-?up|summed from|generated as/i.test(text) && !derived.has(target)) {
          // `generated as` is allowed to describe a sibling the hint explains.
          const explainsADerivedSibling = [...derived].some((d) => text.toLowerCase().includes(d.replace(/_/g, " ")) || text.includes(d));
          if (!explainsADerivedSibling) claims.push(`${c.slug}.${f.name}: "${text.slice(0, 70)}"`);
        }
      }
    }
    expect(claims).toEqual([]);
  });

  test("a customer's order count is counted, not typed", async () => {
    // Same class as the two above: the number existed, nothing kept it, and my
    // own admin panel had to render "stored" beside "what the orders say" so a
    // merchant could see them disagree. `total_spent` beside it stays manual on
    // purpose — a money rollup is refused across denominations.
    const customers = await get<{ id: string; orders_count: number }[]>("customers?limit=5");
    const withOrders = customers.find((c) => c.orders_count > 0);
    expect(withOrders).toBeDefined();

    const before = withOrders as { id: string; orders_count: number };
    const made = await write("orders", {
      customer: before.id,
      email: "counted@example.test",
      state: "open",
      total: 10,
      currency: "USD",
      placed_at: Date.now(),
    });
    expect(made.status).toBe(201);
    const after = await get<{ orders_count: number }>(`customers/${before.id}`);
    expect(after.orders_count).toBe(before.orders_count + 1);

    // And a cancelled order drops back out — the rollup carries the filter.
    const { data: order } = (await made.json()) as { data: { id: string } };
    expect(
      (await write(`orders/${order.id}`, { state: "cancelled", cancel_reason: "customer", cancelled_at: Date.now() }, "PATCH")).status,
    ).toBe(200);
    const cancelled = await get<{ orders_count: number }>(`customers/${before.id}`);
    expect(cancelled.orders_count).toBe(before.orders_count);
  });

  test("the stock KPI sums where stock actually is", () => {
    const kpi = (TEMPLATE_KPIS.ecommerce ?? []).find((k) => k.slug === "stock-on-hand");
    expect(kpi).toBeDefined();
    // It used to sum `products.stock`, which was hand-kept and shipped seeded
    // at 120 against variants holding 90. That column is derived now, so both
    // would agree — the levels stay the source anyway, because they are where
    // the figure is entered and the only place a location can be filtered on.
    expect(kpi?.collection).toBe("inventory_levels");
    expect(kpi?.field).toBe("on_hand");
  });
});
