/**
 * A second template applied onto a workspace that already owns one of its
 * collection names must not abandon the apply partway.
 *
 * A template's sample rows point at their neighbours by `{ ref: "<slug>:<n>" }`,
 * and a ref resolves only against collections THIS apply seeded. Apply
 * `field-service` and then `ecommerce` — both own a `customers` collection —
 * and the second apply correctly SKIPS creating `customers`, which leaves every
 * sample naming `customers:0` pointing at nothing.
 *
 * That used to resolve to `null`, hit the relation's NOT NULL constraint, and
 * escape as a raw driver error: `500 Internal server error`, with the workspace
 * left holding 39 of the 61 new collections and no way for the caller to learn
 * which. The remaining 22 simply did not exist.
 *
 * Now the unbuildable rows are skipped and named in `samplesSkipped`, so the
 * apply completes and the caller can see exactly what could not be seeded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEMPLATES } from "../src/server/templates/catalog";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

interface ApplyResult {
  created: string[];
  skipped: string[];
  seeded: number;
  samplesSkipped: Record<string, string[]>;
}

describe("applying a template over a colliding one", () => {
  let h: TestHarness;
  let second: ApplyResult;

  const apply = async (templateId: string): Promise<{ status: number; data: ApplyResult }> => {
    const res = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId }),
    });
    const body = (await res.json()) as { data: ApplyResult };
    return { status: res.status, data: body.data };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const first = await apply("field-service");
    expect(first.status).toBe(201);
    expect(first.data.created).toContain("customers");
    const out = await apply("ecommerce");
    expect(out.status).toBe(201);
    second = out.data;
  });

  afterAll(() => h.cleanup());

  test("the apply completes rather than 500-ing on the first unresolvable ref", () => {
    // Everything the commerce model declares, minus the one name this workspace
    // already owned. Derived rather than typed out: a hardcoded count breaks on
    // the next collection the template gains and says nothing about the applier
    // when it does — the property is "created + skipped covers the template",
    // not "the number is 61".
    const declared = TEMPLATES.find((t) => t.id === "ecommerce")!.collections.length;
    expect(second.skipped).toEqual(["customers"]);
    expect(second.created.length).toBe(declared - second.skipped.length);
  });

  test("every collection the template names exists afterwards", async () => {
    const res = await h.fetch("/api/collections");
    const body = (await res.json()) as { data: { slug: string }[] };
    const slugs = new Set(body.data.map((c) => c.slug));
    // The ones that used to be missing — everything after `orders` in
    // dependency order, which is where the seed died.
    for (const slug of ["orders", "order_items", "fulfillments", "refunds", "returns", "gift_cards"]) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  test("what could not be seeded is named, not silently dropped", () => {
    // `orders` samples reference `customers:0`, which this apply did not seed.
    expect(Object.keys(second.samplesSkipped)).toContain("orders");
    expect(second.samplesSkipped.orders?.some((r) => r.startsWith("customers:"))).toBe(true);
    // And the rows that depend on those orders cascade, by the same rule.
    expect(Object.keys(second.samplesSkipped)).toContain("order_items");
  });

  test("the rows that COULD be built were", () => {
    // Everything not downstream of `customers` still seeds.
    expect(second.seeded).toBeGreaterThan(50);
  });

  test("a seeded row never carries a null where its sample named a neighbour", async () => {
    const res = await h.fetch("/api/items/order_items?limit=50");
    const body = (await res.json()) as { data: { order: string | null }[] };
    for (const row of body.data) expect(row.order).not.toBeNull();
  });
});

describe("a template applied to an empty workspace is unaffected", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("nothing is skipped and every sample lands", async () => {
    const res = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: ApplyResult };
    expect(data.skipped).toEqual([]);
    expect(data.samplesSkipped).toEqual({});
    expect(data.seeded).toBeGreaterThan(100);
  });
});
