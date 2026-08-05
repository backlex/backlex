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

  test("unknown groupBy field → 422 listing valid columns (helps self-correct)", async () => {
    const { status, json } = await agg({ agg: "count", groupBy: "customer_id" });
    expect(status).toBe(422);
    const msg = (json as { error: { message: string } }).error.message;
    expect(msg).toContain("Valid columns:");
    // The real columns are surfaced so a near-miss can be corrected.
    expect(msg).toContain("status");
    expect(msg).toContain("total");
  });

  test("non-numeric sum field → 422 listing numeric columns", async () => {
    const { status, json } = await agg({ agg: "sum", field: "status" });
    expect(status).toBe(422);
    const msg = (json as { error: { message: string } }).error.message;
    expect(msg).toContain("Numeric columns:");
    expect(msg).toContain("total");
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

/**
 * Versioned collections expose a managed `_status` lifecycle column that isn't
 * in `fields`. Grouping a count by `_status` (draft vs published) is a textbook
 * CMS dashboard query, so the aggregate engine must treat it as a known column
 * on versioned collections — and keep rejecting it on non-versioned ones so a
 * typo still gets a friendly error.
 */
describe("items aggregate — versioned `_status`", () => {
  let h: TestHarness;
  const slug = `aggv_${Date.now()}`;

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
      versioned: true,
      fields: [{ name: "title", type: "text", required: true }],
    });
    // Three drafts; publish one so the group counts differ.
    const ids: string[] = [];
    for (const title of ["a", "b", "c"]) {
      const res = await json(`/api/items/${slug}`, { title });
      ids.push(((await res.json()) as { data: { id: string } }).data.id);
    }
    await json(`/api/items/${slug}/${ids[0]}/publish`, {});
  });
  afterAll(() => h.cleanup());

  test("count grouped by `_status` returns draft + published groups", async () => {
    const res = await h.fetch(`/api/items/${slug}/aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agg: "count", groupBy: "_status" }),
    });
    expect(res.status).toBe(200);
    const rows = (res.json ? await res.json() : { data: [] }) as {
      data: Array<{ label: string; value: unknown }>;
    };
    const byLabel = Object.fromEntries(rows.data.map((r) => [r.label, Number(r.value)]));
    expect(byLabel.published).toBe(1);
    expect(byLabel.draft).toBe(2);
  });
});

/**
 * A filter on a column the collection does not have.
 *
 * `field` and `groupBy` were always checked; filter keys were not — and on
 * SQLite an unresolved double-quoted identifier degrades to a STRING LITERAL
 * of its own name. So `{"missing_col": {"_gte": 1}}` compared the text
 * 'missing_col' against a number (text sorts after every number), the clause
 * was TRUE for every row, and the "filtered" count came back as the UNFILTERED
 * total. The same query with `_eq` was FALSE for every row and answered zero.
 * Neither errored, so a stale filter column on a dashboard tile reported a
 * number nobody had reason to doubt.
 */
describe("items aggregate: a filter must name a real column", () => {
  let h: TestHarness;
  const slug = `aggfilter_${Date.now()}`;

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
    await json(`/api/items/${slug}`, { status: "paid", total: 10 });
    await json(`/api/items/${slug}`, { status: "paid", total: 20 });
  });
  afterAll(() => h.cleanup());

  const agg = async (body: unknown) => {
    const res = await h.fetch(`/api/items/${slug}/aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  test("an unknown filter column is rejected, not silently ignored", async () => {
    const { status, text } = await agg({
      agg: "count",
      filter: { placed_at: { _gte: 1 } },
    });
    expect(status).toBe(422);
    expect(text).toContain("placed_at");
    // The error names what IS available, so a near-miss is correctable.
    expect(text).toContain("status");
  });

  test("the same unknown column under `_eq` is rejected too", async () => {
    // Before the fix this answered 0 rather than the 2 the `_gte` form
    // answered — same wrong filter, opposite wrong answer.
    const { status } = await agg({ agg: "count", filter: { placed_at: { _eq: "x" } } });
    expect(status).toBe(422);
  });

  test("an unknown column nested under a combinator is rejected", async () => {
    const { status } = await agg({
      agg: "count",
      filter: { $and: [{ status: { _eq: "paid" } }, { nope: { _eq: 1 } }] },
    });
    expect(status).toBe(422);
  });

  test("a relation path says aggregate is single-table rather than failing at SQL", async () => {
    const { status, text } = await agg({
      agg: "count",
      filter: { "customer.name": { _eq: "Ada" } },
    });
    expect(status).toBe(422);
    expect(text).toContain("single-table");
  });

  test("real columns and system columns still filter normally", async () => {
    const paid = await agg({ agg: "count", filter: { status: { _eq: "paid" } } });
    expect(paid.status).toBe(200);
    expect(JSON.parse(paid.text).data[0].value).toBe(2);

    const none = await agg({ agg: "count", filter: { status: { _eq: "void" } } });
    expect(JSON.parse(none.text).data[0].value).toBe(0);

    const sys = await agg({ agg: "count", filter: { created_at: { _gte: 0 } } });
    expect(sys.status).toBe(200);
    expect(JSON.parse(sys.text).data[0].value).toBe(2);
  });
});
