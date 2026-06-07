/**
 * Items aggregation — `POST /api/items/:slug/aggregate` (count/sum/avg/min/max
 * + groupBy), plus the Ask AI planner dry-run guard for `collections.aggregate`.
 * The endpoint is permission-gated (read rows + fields) and tenant-scoped; the
 * engine is the same `runItemsAggregate` dashboard panels use.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { dryRunPlan } from "../src/server/routes/ai-ask";

describe("items aggregate endpoint", () => {
  let h: TestHarness;
  const slug = `agg_${Date.now()}`;

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
    await json(`/api/items/${slug}`, { status: "active", total: 100 });
    await json(`/api/items/${slug}`, { status: "active", total: 50 });
    await json(`/api/items/${slug}`, { status: "draft", total: 25 });
  });
  afterAll(() => h.cleanup());

  const agg = async (body: unknown) => {
    const res = await h.fetch(`/api/items/${slug}/aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  test("scalar sum over all rows", async () => {
    const { status, json } = await agg({ agg: "sum", field: "total" });
    expect(status).toBe(200);
    expect(Number((json as { data: Array<{ value: unknown }> }).data[0]!.value)).toBe(175);
  });

  test("count grouped by status, ordered by value desc", async () => {
    const { status, json } = await agg({ agg: "count", groupBy: "status" });
    expect(status).toBe(200);
    const rows = (json as { data: Array<{ label: string; value: unknown }> }).data;
    expect(rows.map((r) => ({ label: r.label, value: Number(r.value) }))).toEqual([
      { label: "active", value: 2 },
      { label: "draft", value: 1 },
    ]);
  });

  test("sum grouped by status (top group first)", async () => {
    const { json } = await agg({ agg: "sum", field: "total", groupBy: "status" });
    const rows = (json as { data: Array<{ label: string; value: unknown }> }).data;
    expect(rows[0]).toEqual({ label: "active", value: rows[0]!.value });
    expect(Number(rows[0]!.value)).toBe(150);
  });

  test("filter is applied before aggregation", async () => {
    const { json } = await agg({
      agg: "sum",
      field: "total",
      filter: { status: { _eq: "active" } },
    });
    expect(Number((json as { data: Array<{ value: unknown }> }).data[0]!.value)).toBe(150);
  });

  test("sum on a non-numeric field → 422", async () => {
    const { status, json } = await agg({ agg: "sum", field: "status" });
    expect(status).toBe(422);
    expect((json as { error: { code: string } }).error.code).toBe("VALIDATION");
  });

  test("unknown groupBy field → 422", async () => {
    const { status } = await agg({ agg: "count", groupBy: "bogus" });
    expect(status).toBe(422);
  });
});

describe("Ask AI dry-run — collections.aggregate", () => {
  let h: TestHarness;
  const slug = `aggdry_${Date.now()}`;
  const fetchInternal = (path: string, init?: RequestInit) => h.fetch(path, init);

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "status", type: "text", required: true },
          { name: "total", type: "integer" },
        ],
      }),
    });
  });
  afterAll(() => h.cleanup());

  test("valid aggregate plan → null", async () => {
    const err = await dryRunPlan(fetchInternal, "collections.aggregate", {
      collection: slug,
      agg: "sum",
      field: "total",
      groupBy: "status",
    });
    expect(err).toBeNull();
  });

  test("non-numeric sum field → VALIDATION surfaced for correction", async () => {
    const err = await dryRunPlan(fetchInternal, "collections.aggregate", {
      collection: slug,
      agg: "sum",
      field: "status",
    });
    expect(err).toContain("VALIDATION");
  });
});
