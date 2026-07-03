import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Coverage for the `private` field flag: the column is stored + writable +
// filterable, but stripped from every API read surface (REST list/get + CSV +
// GraphQL). Runs against the harness SQLite (same code path serves PG).
describe("private field flag", () => {
  let h: TestHarness;
  const slug = "leads";

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };

  const create = async (body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "email", type: "text", required: true },
          { name: "internal_score", type: "integer", private: true },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("create accepts a private field but the response omits it", async () => {
    const { status, body } = await create({ email: "a@x.com", internal_score: 42 });
    expect(status).toBe(201);
    expect(body.data.email).toBe("a@x.com");
    expect("internal_score" in body.data).toBe(false);
  });

  test("get-by-id and list both omit the private field", async () => {
    const { body } = await create({ email: "b@x.com", internal_score: 7 });
    const id = body.data.id;

    const one = (await (await h.fetch(`/api/items/${slug}/${id}`)).json()).data as Record<string, unknown>;
    expect(one.email).toBe("b@x.com");
    expect("internal_score" in one).toBe(false);

    const list = (await (await h.fetch(`/api/items/${slug}`)).json()).data as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) expect("internal_score" in row).toBe(false);
  });

  test("the value is still stored — filtering by it returns the row", async () => {
    await create({ email: "c@x.com", internal_score: 999 });
    const filter = encodeURIComponent(JSON.stringify({ internal_score: { _eq: 999 } }));
    const r = await h.fetch(`/api/items/${slug}?filter=${filter}`);
    const rows = (await r.json()).data as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("c@x.com");
    // …but the matched row still doesn't leak the private value.
    expect("internal_score" in rows[0]!).toBe(false);
  });

  test("GraphQL neither exposes the field on the type nor returns it", async () => {
    await create({ email: "g@x.com", internal_score: 5 });
    // Selecting the private field is a schema error (field not on the type).
    const bad = await gql(`{ leads { email internalScore } }`);
    expect(bad.errors?.length ?? 0).toBeGreaterThan(0);
    // A normal query returns rows without the private key.
    const ok = await gql(`{ leads { email } }`);
    expect(ok.errors ?? []).toHaveLength(0);
    expect(ok.data?.leads?.length).toBeGreaterThan(0);
    for (const row of ok.data!.leads) expect("internalScore" in row).toBe(false);
  });
});
