import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * GraphQL parity for the items query extras that were REST-only until 2026-07:
 * `<collection>Aggregate` (count/sum/avg/min/max + groupBy) and
 * `<collection>Search` (fts/vector/hybrid relevance). Both resolvers delegate
 * to the same services as REST (`runItemsAggregate`,
 * `searchCollectionItems`), so these specs pin wiring + validation parity —
 * ranking/permission behavior is covered by fulltext-search.test.ts and the
 * aggregate REST specs.
 */
const json = { "content-type": "application/json" };

const gqlFetch =
  (h: TestHarness) => async (query: string, variables?: unknown) =>
    (await (
      await h.fetch("/api/graphql", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ query, variables }),
      })
    ).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

describe("GraphQL aggregate + search parity", () => {
  let h: TestHarness;
  let gql: ReturnType<typeof gqlFetch>;
  const slug = "gqlsearch";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    gql = gqlFetch(h);
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug,
        fts: true,
        fields: [
          { name: "title", type: "text", searchable: true },
          { name: "body", type: "longtext", searchable: true },
          { name: "price", type: "number" },
          { name: "category", type: "text" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const rows = [
      { title: "Postgres tuning guide", body: "indexes and query planning", price: 10, category: "db" },
      { title: "SQLite internals", body: "btree wal and the page cache", price: 20, category: "db" },
      { title: "Baking sourdough", body: "flour water salt starter", price: 5, category: "food" },
    ];
    for (const r of rows) {
      const created = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(r),
      });
      expect(created.status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  test("aggregate: count, grouped sum, and validation parity", async () => {
    const count = await gql(`{ gqlsearchAggregate(agg:"count") }`);
    expect(count.errors).toBeUndefined();
    expect(count.data?.gqlsearchAggregate).toEqual([{ value: 3 }]);

    const grouped = await gql(
      `{ gqlsearchAggregate(agg:"sum", field:"price", groupBy:"category") }`,
    );
    expect(grouped.errors).toBeUndefined();
    expect(grouped.data?.gqlsearchAggregate).toEqual([
      { label: "db", value: 30 },
      { label: "food", value: 5 },
    ]);

    const filtered = await gql(
      `query($f:JSON){ gqlsearchAggregate(agg:"count", filter:$f) }`,
      { f: { category: "db" } },
    );
    expect(filtered.data?.gqlsearchAggregate).toEqual([{ value: 2 }]);

    const badAgg = await gql(`{ gqlsearchAggregate(agg:"median") }`);
    expect(badAgg.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    // sum over a non-numeric field mirrors the REST service's VALIDATION error.
    const badField = await gql(`{ gqlsearchAggregate(agg:"sum", field:"title") }`);
    expect(badField.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("search: fts ranking rides the typed collection rows", async () => {
    const res = await gql(
      `query($q:String!){ gqlsearchSearch(q:$q){ id title price } }`,
      { q: "postgres" },
    );
    expect(res.errors).toBeUndefined();
    const rows = res.data?.gqlsearchSearch as { title: string; price: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.title).toBe("Postgres tuning guide");
    expect(rows[0]?.price).toBe(10);

    const none = await gql(`{ gqlsearchSearch(q:"zeppelin"){ id } }`);
    expect(none.data?.gqlsearchSearch).toEqual([]);
  });

  test("search: mode/limit validation parity", async () => {
    const badMode = await gql(`{ gqlsearchSearch(q:"x", mode:"psychic"){ id } }`);
    expect(badMode.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    // vector isn't configured on this collection → precise 422-style error.
    const noVector = await gql(`{ gqlsearchSearch(q:"x", mode:"vector"){ id } }`);
    expect(noVector.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const badLimit = await gql(`{ gqlsearchSearch(q:"x", limit:0){ id } }`);
    expect(badLimit.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("search on a collection without fts/vector is a VALIDATION error", async () => {
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug: "gqlplain", fields: [{ name: "name", type: "text" }] }),
    });
    expect(res.status).toBe(201);
    const out = await gql(`{ gqlplainSearch(q:"x"){ id } }`);
    expect(out.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});
