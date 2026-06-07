/**
 * Phase 4 — the SDK fluent query builder (@backlex/client). Asserts the builder
 * COMPILES to the canonical `ListQuery` JSON (unit), and that a builder-produced
 * query is accepted by the real list endpoint (integration) — proving the
 * ergonomics layer stays on the one wire format.
 *
 * Imported by relative source path: @backlex/client isn't a direct dep of
 * apps/web, but it's source-consumed and its imports (@backlex/core, ./types)
 * resolve here.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { QueryBuilder } from "../../../packages/client/src/query";
import type { ListQuery, ListResponse } from "../../../packages/client/src/types";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

interface Order extends Record<string, unknown> {
  id: string;
  status: string;
  total: number;
  placed_at: number;
}

// A builder whose list() just returns the assembled query for inspection.
const captureBuilder = <T extends Record<string, unknown>>() => {
  let captured: ListQuery | undefined;
  const b = new QueryBuilder<T>((q) => {
    captured = q;
    return Promise.resolve({ data: [], limit: 0, offset: 0 } as ListResponse<T>);
  });
  return { b, get: () => captured };
};

describe("SDK QueryBuilder — compiles to canonical ListQuery", () => {
  test("where/select/orderBy/limit → canonical JSON", () => {
    const { b } = captureBuilder<Order>();
    const q = b
      .where((f) =>
        f.and(
          f.eq("status", "active"),
          f.gte("total", 100),
          f.rel("customer", (c) => c.eq("tier", "gold")),
          f.gte("placed_at", f.now({ sub: { months: 1 } })),
        ),
      )
      .select("id", "total", "customer.name")
      .orderBy("-placed_at", "id")
      .limit(50)
      .toQuery();

    expect(q.filter).toEqual({
      $and: [
        { status: { _eq: "active" } },
        { total: { _gte: 100 } },
        { "customer.tier": { _eq: "gold" } },
        { placed_at: { _gte: { $now: { sub: { months: 1 } } } } },
      ],
    });
    expect(q.sort).toEqual(["-placed_at", "id"]);
    expect(q.fields).toEqual(["id", "total", "customer.name"]);
    expect(q.limit).toBe(50);
  });

  test("rel() prefixes nested and/or branches", () => {
    const { b } = captureBuilder<Order>();
    const q = b
      .where((f) => f.rel("customer", (c) => c.or(c.eq("tier", "gold"), c.gte("ltv", 1000))))
      .toQuery();
    expect(q.filter).toEqual({
      $or: [{ "customer.tier": { _eq: "gold" } }, { "customer.ltv": { _gte: 1000 } }],
    });
  });

  test("between / icontains / isNull helpers", () => {
    const { b } = captureBuilder<Order>();
    const q = b
      .where((f) =>
        f.and(f.between("total", 10, 20), f.icontains("status", "ACT"), f.isNull("placed_at", false)),
      )
      .toQuery();
    expect(q.filter).toEqual({
      $and: [
        { total: { _between: [10, 20] } },
        { status: { _icontains: "ACT" } },
        { placed_at: { _null: false } },
      ],
    });
  });

  test("empty builder → empty query", () => {
    const { b } = captureBuilder<Order>();
    expect(b.toQuery()).toEqual({});
  });
});

describe("SDK QueryBuilder — output accepted by the real endpoint", () => {
  let h: TestHarness;
  const slug = `sdk_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const json = (path: string, body: unknown) =>
      h.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await json("/api/collections", {
      slug,
      fields: [
        { name: "status", type: "text", required: true },
        { name: "total", type: "integer" },
      ],
    });
    await json(`/api/items/${slug}`, { status: "active", total: 150 });
    await json(`/api/items/${slug}`, { status: "draft", total: 50 });
  });
  afterAll(() => h.cleanup());

  test("a builder-compiled query runs through GET /api/items", async () => {
    const { b } = captureBuilder<Record<string, unknown>>();
    const q = b
      .where((f) => f.and(f.eq("status", "active"), f.gte("total", 100)))
      .orderBy("-total")
      .toQuery();
    // Replay the compiled ListQuery against the real endpoint.
    const params = new URLSearchParams();
    if (q.filter) params.set("filter", JSON.stringify(q.filter));
    if (q.sort) params.set("sort", (q.sort as string[]).join(","));
    const res = await h.fetch(`/api/items/${slug}?${params}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ status: string }> };
    expect(body.data.map((r) => r.status)).toEqual(["active"]);
  });
});
