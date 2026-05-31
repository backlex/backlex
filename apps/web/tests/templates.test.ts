import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("schema templates", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("catalog lists vertical templates", async () => {
    const res = await h.fetch("/api/admin/templates");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; collections: unknown[] }[] };
    const ids = data.map((t) => t.id);
    expect(ids).toContain("ecommerce");
    expect(ids).toContain("blank");
    expect(data.find((t) => t.id === "ecommerce")!.collections.length).toBeGreaterThan(5);
  });

  test("applying ecommerce seeds its collections + is idempotent", async () => {
    const apply = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    expect(apply.status).toBe(201);
    const { data } = (await apply.json()) as { data: { created: string[]; skipped: string[] } };
    expect(data.created).toContain("products");
    expect(data.created).toContain("orders");

    // Collections now exist and are usable.
    const list = await h.fetch("/api/collections");
    const listed = (await list.json()) as { data: { slug: string }[] };
    const slugs = listed.data.map((c) => c.slug);
    expect(slugs).toContain("products");
    expect(slugs).toContain("order_items");

    // A new product row can be created against the materialized table.
    const create = await h.fetch("/api/items/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Widget", price: 9.99, sku: "W-1" }),
    });
    expect([200, 201]).toContain(create.status);

    // Re-apply → everything skipped, nothing duplicated.
    const again = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    const { data: d2 } = (await again.json()) as { data: { created: string[]; skipped: string[] } };
    expect(d2.created).toHaveLength(0);
    expect(d2.skipped).toContain("products");
  });

  test("unknown template id is rejected", async () => {
    const res = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "nope" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
