/**
 * `/api/graphql` refuses a document it cannot afford — before execution, and
 * before the tenant schema is even built.
 *
 * The schema is generated from tenant metadata, so nothing bounds how deep a
 * relation chain a caller may walk or how large a `limit` they may put on each
 * hop. Without a budget one accepted document fans out into millions of rows.
 * These assertions pin the three axes (depth, cost, aliases), the escape
 * hatches that must NOT be closed (introspection, an ordinary query), and the
 * two ways a caller could otherwise dodge the estimate — a variable `limit`,
 * and a fragment that hides the nesting.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parse } from "graphql";
import {
  DEFAULT_MAX_ALIASES,
  DEFAULT_MAX_COST,
  DEFAULT_MAX_DEPTH,
  budgetFromEnv,
  measure,
  overBudget,
} from "../src/server/services/graphql/cost";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const BUDGET = budgetFromEnv({});

describe("GraphQL cost budget — measurement", () => {
  test("nested limits multiply, they do not add", () => {
    // 10 orders × 10 lines × 10 parts = the row count a naive walk misses.
    const r = measure(
      parse(`{ orders(limit: 10) { lines(limit: 10) { parts(limit: 10) { id } } } }`),
    );
    expect(r.cost).toBeGreaterThanOrEqual(1000);
    expect(r.depth).toBe(4);
  });

  test("a variable limit is charged the assumed page size, not 1", () => {
    const withVar = measure(parse(`query ($n: Int) { orders(limit: $n) { id } }`));
    const withLiteralOne = measure(parse(`{ orders(limit: 1) { id } }`));
    expect(withVar.cost).toBeGreaterThan(withLiteralOne.cost);
  });

  test("a fragment's nesting counts toward depth", () => {
    const inline = measure(parse(`{ a { b { c { d { id } } } } }`));
    const viaFragment = measure(
      parse(`{ a { ...F } } fragment F on B { b { c { d { id } } } }`),
    );
    expect(viaFragment.depth).toBe(inline.depth);
  });

  test("a cyclic fragment spread terminates instead of hanging", () => {
    const doc = parse(`{ a { ...F } } fragment F on A { a { ...F } }`);
    expect(() => measure(doc)).not.toThrow();
  });

  test("aliases of one field are counted", () => {
    const q = Array.from({ length: 5 }, (_, i) => `a${i}: orders { id }`).join(" ");
    expect(measure(parse(`{ ${q} }`)).aliases).toBe(5);
  });

  test("an introspection-only document is free", () => {
    const r = measure(parse(`{ __schema { types { name fields { name } } } }`));
    expect(r.cost).toBe(0);
    expect(overBudget(parse(`{ __schema { types { name } } }`), BUDGET)).toBeNull();
  });

  test("each axis is reported with the limit that rejected it", () => {
    const deep = `{ ${"a { ".repeat(DEFAULT_MAX_DEPTH + 1)} id ${"}".repeat(DEFAULT_MAX_DEPTH + 1)} }`;
    expect(overBudget(parse(deep), BUDGET)).toContain("deeply nested");

    const aliased = Array.from(
      { length: DEFAULT_MAX_ALIASES + 1 },
      (_, i) => `a${i}: orders { id }`,
    ).join(" ");
    expect(overBudget(parse(`{ ${aliased} }`), BUDGET)).toContain("aliases");

    const costly = `{ orders(limit: ${DEFAULT_MAX_COST}) { lines(limit: 100) { id } } }`;
    expect(overBudget(parse(costly), BUDGET)).toContain("cost");
  });

  test("env overrides apply, and a nonsense value falls back rather than rejecting everything", () => {
    expect(budgetFromEnv({ GRAPHQL_MAX_DEPTH: "3" }).maxDepth).toBe(3);
    expect(budgetFromEnv({ GRAPHQL_MAX_DEPTH: "not-a-number" }).maxDepth).toBe(DEFAULT_MAX_DEPTH);
    expect(budgetFromEnv({ GRAPHQL_MAX_COST: "0" }).maxCost).toBe(DEFAULT_MAX_COST);
    expect(budgetFromEnv({ GRAPHQL_MAX_COST: "-5" }).maxCost).toBe(DEFAULT_MAX_COST);
  });
});

describe("GraphQL cost budget — over the wire", () => {
  let h: TestHarness;
  const posts = "budgetposts";

  const gql = async (query: string) =>
    await h.fetch("/api/graphql", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ query }),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: posts,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(r.status).toBe(201);
    await h.fetch(`/api/items/${posts}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "hello" }),
    });
  });

  afterAll(() => h.cleanup());

  test("an ordinary query still runs", async () => {
    const res = await gql(`{ ${posts} { id title } }`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Record<string, unknown[]>; errors?: unknown[] };
    expect(body.errors).toBeUndefined();
    expect(body.data?.[posts]?.length).toBe(1);
  });

  test("introspection still runs — GraphiQL must keep working", async () => {
    const res = await gql(`{ __schema { queryType { name } } }`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors?: unknown[] };
    expect(body.errors).toBeUndefined();
  });

  test("an over-budget document is refused with 422, not executed", async () => {
    const res = await gql(`{ ${posts}(limit: ${DEFAULT_MAX_COST}) { id title } }`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(JSON.stringify(body)).toContain("cost");
  });

  test("a batched payload is measured per operation", async () => {
    const res = await h.fetch("/api/graphql", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify([
        { query: `{ ${posts} { id } }` },
        { query: `{ ${posts}(limit: ${DEFAULT_MAX_COST}) { id title } }` },
      ]),
    });
    expect(res.status).toBe(422);
  });

  test("a syntax error stays yoga's to report, not a 422 from the guard", async () => {
    const res = await gql(`{ ${posts} `);
    expect(res.status).not.toBe(422);
  });

  // yoga parses five request shapes. Any one the guard doesn't recognise is a
  // way around the budget, so each is asserted separately — a JSON-only guard
  // passes every test above and still leaves four open doors.
  describe("every request shape yoga accepts is measured", () => {
    const costly = () => `{ ${posts}(limit: ${DEFAULT_MAX_COST}) { id title } }`;

    test("GET ?query=", async () => {
      const res = await h.fetch(`/api/graphql?query=${encodeURIComponent(costly())}`);
      expect(res.status).toBe(422);
    });

    test("POST application/json with a charset parameter", async () => {
      const res = await h.fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ query: costly() }),
      });
      expect(res.status).toBe(422);
    });

    test("POST application/graphql — the body IS the document", async () => {
      const res = await h.fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/graphql" },
        body: costly(),
      });
      expect(res.status).toBe(422);
    });

    test("POST application/x-www-form-urlencoded", async () => {
      const res = await h.fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query: costly() }).toString(),
      });
      expect(res.status).toBe(422);
    });

    test("POST multipart/form-data with an operations field", async () => {
      const fd = new FormData();
      fd.set("operations", JSON.stringify({ query: costly() }));
      const res = await h.fetch("/api/graphql", { method: "POST", body: fd });
      expect(res.status).toBe(422);
    });

    test("an affordable query still runs through the non-JSON shapes", async () => {
      const ok = `{ ${posts} { id } }`;
      const raw = await h.fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/graphql" },
        body: ok,
      });
      expect(raw.status).toBe(200);
      const form = await h.fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query: ok }).toString(),
      });
      expect(form.status).toBe(200);
    });
  });
});
