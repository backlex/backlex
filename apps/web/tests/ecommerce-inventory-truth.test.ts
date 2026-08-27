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
 * The second cannot be a rollup at all: a variant's count is now summed from
 * its levels, and a rollup of a rollup does not refresh — the write path
 * restates a parent from its children with a direct UPDATE that never re-enters
 * the write path to restate the grandparent. So the claim was removed instead,
 * and the `stock-on-hand` KPI repointed at the levels.
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

  test("a variant's on-hand is summed from its levels and follows a level write", async () => {
    const [level] = await get<Level[]>("inventory_levels?limit=1");
    const before = level as Level;
    const variantBefore = await get<{ inventory_quantity: number; product: string }>(
      `product_variants/${before.variant}`,
    );

    expect((await write(`inventory_levels/${before.id}`, { on_hand: before.on_hand + 25 }, "PATCH")).status).toBe(200);
    const variantAfter = await get<{ inventory_quantity: number }>(`product_variants/${before.variant}`);
    expect(variantAfter.inventory_quantity).toBe(variantBefore.inventory_quantity + 25);
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
    // `products.stock` is hand-kept and shipped seeded at 120 against variants
    // holding 90, so a KPI summing it reports a number nothing maintains.
    expect(kpi?.collection).toBe("inventory_levels");
    expect(kpi?.field).toBe("on_hand");
  });
});
