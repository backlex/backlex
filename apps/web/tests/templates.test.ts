import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { columnDefSql, type FieldDef } from "@backlex/db";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("column defaults (DDL)", () => {
  test("emits DEFAULT for scalar fields, per dialect", () => {
    const boolF: FieldDef = { name: "featured", type: "boolean", default: false };
    expect(columnDefSql(boolF, "sqlite")).toBe(`"featured" INTEGER DEFAULT 0`);
    expect(columnDefSql(boolF, "pg")).toBe(`"featured" boolean DEFAULT false`);

    const intF: FieldDef = { name: "qty", type: "integer", default: 0, required: true };
    expect(columnDefSql(intF, "sqlite")).toBe(`"qty" INTEGER DEFAULT 0 NOT NULL`);

    const txtF: FieldDef = { name: "status", type: "text", default: "draft" };
    expect(columnDefSql(txtF, "pg")).toBe(`"status" varchar(255) DEFAULT 'draft'`);
  });

  test("ignores default on computed and non-scalar types", () => {
    const computed: FieldDef = {
      name: "total", type: "number", default: 0, computed: { formula: "qty * price" },
    };
    expect(columnDefSql(computed, "sqlite")).not.toContain("DEFAULT");

    const rel: FieldDef = { name: "author", type: "relation", to: "authors", default: "x" as never };
    expect(columnDefSql(rel, "sqlite")).not.toContain("DEFAULT");
  });
});

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

// Fresh workspace so the seed counts are deterministic (no collisions with the
// collections the shared-harness suite above creates).
describe("schema template sample seeding", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("applying blog seeds sample data, enables fts, and applies column defaults", async () => {
    const apply = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "blog" }),
    });
    expect(apply.status).toBe(201);
    const { data } = (await apply.json()) as {
      data: { created: string[]; seeded: number };
    };
    expect(data.created).toContain("posts");
    // authors 2 + categories 2 + tags 2 + posts 2 + pages 2 = 10 sample rows.
    expect(data.seeded).toBe(10);

    // Sample rows are queryable — relation refs resolved to real ids.
    const authorsRes = await h.fetch("/api/items/authors");
    const authors = (await authorsRes.json()) as { data: { id: string; name: string }[] };
    expect(authors.data.map((a) => a.name)).toContain("Ada Lovelace");

    const postsRes = await h.fetch("/api/items/posts");
    const posts = (await postsRes.json()) as {
      data: { title: string; author: string | null; featured: boolean }[];
    };
    expect(posts.data.length).toBe(2);
    const hello = posts.data.find((p) => p.title === "Hello, world")!;
    expect(hello).toBeDefined();
    // Relation ref resolved to a real author id.
    expect(authors.data.some((a) => a.id === hello.author)).toBe(true);
    // Column DEFAULT applied — `featured` was omitted on this sample row.
    expect(hello.featured).toBe(false);

    // fts threaded through the template → the posts collection has it enabled.
    const colsRes = await h.fetch("/api/collections");
    const cols = (await colsRes.json()) as { data: { slug: string; fts: boolean }[] };
    expect(cols.data.find((c) => c.slug === "posts")!.fts).toBe(true);

    // Re-apply → no duplicate seeding.
    const again = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "blog" }),
    });
    const { data: d2 } = (await again.json()) as { data: { seeded: number } };
    expect(d2.seeded).toBe(0);
  });

  test("ecommerce template ships computed columns, validation and choice membership", async () => {
    const h2 = makeHarness();
    await seedAdmin(h2);
    const post = (slug: string, body: unknown) =>
      h2.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const apply = await h2.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    expect(apply.status).toBe(201);

    // Computed column: order_items.line_total = qty * unit_price (seeded rows).
    const oiRes = await h2.fetch("/api/items/order_items");
    const oi = (await oiRes.json()) as { data: { qty: number; unit_price: number; line_total: number }[] };
    expect(oi.data.length).toBeGreaterThan(0);
    for (const row of oi.data) expect(row.line_total).toBe(row.qty * row.unit_price);

    // Writing a computed column is rejected (read-only end-to-end).
    expect((await post("order_items", { qty: 1, unit_price: 5, line_total: 999 })).status).toBe(422);

    // Soft validation: price has min 0; rating is 1..5.
    expect((await post("products", { name: "Bad", price: -5, sku: "NEG-1" })).status).toBe(422);
    expect((await post("reviews", { rating: 6 })).status).toBe(422);

    // Colored dropdown enforces choice membership.
    expect((await post("orders", { number: "X-1", status: "not-a-status" })).status).toBe(422);
    expect((await post("orders", { number: "X-2", status: "paid" })).status).toBeLessThan(300);

    h2.cleanup();
  });

  // Every new vertical must materialize (incl. computed columns / relation refs)
  // and seed its sample data without error, into a clean workspace each.
  const NEW_VERTICALS = ["real-estate", "restaurant", "lms", "ats", "marketplace", "nonprofit", "forms"];
  for (const id of NEW_VERTICALS) {
    test(`vertical "${id}" applies + seeds cleanly`, async () => {
      const hv = makeHarness();
      await seedAdmin(hv);
      const res = await hv.fetch("/api/admin/templates/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: id }),
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { created: string[]; seeded: number } };
      expect(data.created.length).toBeGreaterThan(0);
      expect(data.seeded).toBeGreaterThan(0);
      hv.cleanup();
    });
  }
});
