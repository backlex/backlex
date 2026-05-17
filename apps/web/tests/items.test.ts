import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("collections + items CRUD as admin", () => {
  let h: TestHarness;
  const slug = `notes_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("create collection, list it, fetch by slug", async () => {
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "body", type: "longtext" },
        ],
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { slug: string; physicalTable: string } };
    expect(created.data.slug).toBe(slug);
    expect(created.data.physicalTable.endsWith(slug)).toBe(true);

    const list = await h.fetch("/api/collections");
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: { slug: string }[] };
    expect(listed.data.some((c) => c.slug === slug)).toBe(true);

    const get = await h.fetch(`/api/collections/${slug}`);
    expect(get.status).toBe(200);
  });

  test("insert, list, update, delete an item", async () => {
    const create = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello", body: "first note" }),
    });
    expect(create.status).toBe(201);
    const inserted = (await create.json()) as { data: { id: string; title: string } };
    expect(inserted.data.title).toBe("hello");
    const id = inserted.data.id;

    const list = await h.fetch(`/api/items/${slug}`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { id: string }[] };
    expect(body.data.some((r) => r.id === id)).toBe(true);

    const patch = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "renamed" }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { data: { title: string } };
    expect(patched.data.title).toBe("renamed");

    const del = await h.fetch(`/api/items/${slug}/${id}`, { method: "DELETE" });
    expect(del.status).toBeLessThan(400);

    const after = await h.fetch(`/api/items/${slug}/${id}`);
    expect(after.status).toBe(404);
  });

  test("filter DSL: _eq matches inserted row, _neq excludes it", async () => {
    await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "unique-match", body: "x" }),
    });
    const filterEq = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ title: { _eq: "unique-match" } }))}`,
    );
    expect(filterEq.status).toBe(200);
    const eqBody = (await filterEq.json()) as { data: { title: string }[] };
    expect(eqBody.data.length).toBe(1);

    const filterNeq = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ title: { _neq: "unique-match" } }))}`,
    );
    const neqBody = (await filterNeq.json()) as { data: { title: string }[] };
    expect(neqBody.data.every((r) => r.title !== "unique-match")).toBe(true);
  });
});

describe("multi-hop nested filter + sort", () => {
  let h: TestHarness;
  let aBerlin = "";
  let aParis = "";
  let cAlice = "";
  let cBob = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const json = async (
      method: string,
      path: string,
      body: unknown,
    ): Promise<any> => {
      const res = await h.fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
      return res.json();
    };

    // addresses → customers (relation) → orders (relation): two hops.
    await json("POST", "/api/collections", {
      slug: "addresses",
      fields: [{ name: "city", type: "text", required: true }],
    });
    await json("POST", "/api/collections", {
      slug: "customers",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "address_id", type: "relation", to: "addresses" },
      ],
    });
    await json("POST", "/api/collections", {
      slug: "orders",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "customer_id", type: "relation", to: "customers" },
      ],
    });

    aBerlin = (await json("POST", "/api/items/addresses", { city: "Berlin" })).data.id;
    aParis = (await json("POST", "/api/items/addresses", { city: "Paris" })).data.id;
    cAlice = (await json("POST", "/api/items/customers", { name: "Alice", address_id: aBerlin })).data.id;
    cBob = (await json("POST", "/api/items/customers", { name: "Bob", address_id: aParis })).data.id;
    await json("POST", "/api/items/orders", { title: "Order-1", customer_id: cAlice });
    await json("POST", "/api/items/orders", { title: "Order-2", customer_id: cBob });
    await json("POST", "/api/items/orders", { title: "Order-3", customer_id: cAlice });
  });

  afterAll(() => {
    h.cleanup();
  });

  test("1-hop filter (regression): customer_id.name == Alice → 2 orders", async () => {
    const res = await h.fetch(
      `/api/items/orders?filter=${encodeURIComponent(JSON.stringify({ "customer_id.name": { _eq: "Alice" } }))}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data.map((r) => r.title).sort()).toEqual(["Order-1", "Order-3"]);
  });

  test("2-hop filter: customer_id.address_id.city == Berlin → Alice's orders", async () => {
    const res = await h.fetch(
      `/api/items/orders?filter=${encodeURIComponent(JSON.stringify({ "customer_id.address_id.city": { _eq: "Berlin" } }))}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data.map((r) => r.title).sort()).toEqual(["Order-1", "Order-3"]);
  });

  test("2-hop filter: customer_id.address_id.city == Paris → Bob's order", async () => {
    const res = await h.fetch(
      `/api/items/orders?filter=${encodeURIComponent(JSON.stringify({ "customer_id.address_id.city": { _eq: "Paris" } }))}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data.map((r) => r.title)).toEqual(["Order-2"]);
  });

  test("2-hop sort DESC + ASC by city", async () => {
    const descRes = await h.fetch(
      `/api/items/orders?sort=${encodeURIComponent("-customer_id.address_id.city")}`,
    );
    expect(descRes.status).toBe(200);
    const desc = (await descRes.json()) as { data: { title: string }[] };
    // Paris > Berlin (lexical DESC) → Order-2 first.
    expect(desc.data[0]?.title).toBe("Order-2");

    const ascRes = await h.fetch(
      `/api/items/orders?sort=${encodeURIComponent("customer_id.address_id.city")}`,
    );
    expect(ascRes.status).toBe(200);
    const asc = (await ascRes.json()) as { data: { title: string }[] };
    // Berlin < Paris (lexical ASC) → Berlin orders first.
    expect(asc.data[asc.data.length - 1]?.title).toBe("Order-2");
  });

  test("4-segment key (a.b.c.d) returns 422", async () => {
    const res = await h.fetch(
      `/api/items/orders?filter=${encodeURIComponent(JSON.stringify({ "customer_id.address_id.city.x": { _eq: "Berlin" } }))}`,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toMatch(/exceeds max depth/);
  });

  test("filter+sort sharing prefix produces one ladder (count + filter_count still correct)", async () => {
    const res = await h.fetch(
      `/api/items/orders?filter=${encodeURIComponent(JSON.stringify({ "customer_id.address_id.city": { _eq: "Berlin" } }))}&sort=${encodeURIComponent("-customer_id.address_id.city")}&meta=filter_count`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      meta?: { filter_count?: number };
    };
    expect(body.data.length).toBe(2);
    expect(body.meta?.filter_count).toBe(2);
  });
});
