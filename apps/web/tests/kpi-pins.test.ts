/**
 * Pinned KPIs — the figure for THIS row.
 *
 * The shape that makes this work is that a pinned KPI aggregates a DIFFERENT
 * collection from the one whose page it appears on: "revenue per product" sums
 * order lines and belongs on a product. So the two things worth pinning down
 * are that `rowId` genuinely narrows through the named relation, and that it is
 * IGNORED on a KPI that is not pinned — returning the collection-wide total
 * under a row's heading would read as "this product made everything", which is
 * exactly the confidently-wrong number this layer exists to prevent.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };

describe("kpis: pinned to a row", () => {
  let h: TestHarness;
  const ts = Date.now();
  const products = `pinprod_${ts}`;
  const lines = `pinline_${ts}`;
  const ids: Record<string, string> = {};

  const post = async (path: string, body: unknown) => {
    const res = await h.fetch(path, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await post("/api/collections", {
      slug: products,
      fields: [{ name: "name", type: "text" }],
    });
    await post("/api/collections", {
      slug: lines,
      fields: [
        { name: "product", type: "relation", to: products },
        { name: "amount", type: "integer" },
      ],
    });
    for (const name of ["widget", "gadget"]) {
      const r = await post(`/api/items/${products}`, { name });
      ids[name] = r.json.data.id;
    }
    // widget: 10 + 15 = 25 across two lines. gadget: 100 across one.
    await post(`/api/items/${lines}`, { product: ids.widget, amount: 10 });
    await post(`/api/items/${lines}`, { product: ids.widget, amount: 15 });
    await post(`/api/items/${lines}`, { product: ids.gadget, amount: 100 });

    await post("/api/admin/kpis", {
      slug: "revenue-per-product",
      name: "Revenue",
      collection: lines,
      agg: "sum",
      field: "amount",
      pinTo: products,
      pinField: "product",
      direction: "up",
    });
    await post("/api/admin/kpis", {
      slug: "unpinned-total",
      name: "All revenue",
      collection: lines,
      agg: "sum",
      field: "amount",
    });
  });
  afterAll(() => h.cleanup());

  const run = async (slug: string, q = "") =>
    ((await (await h.fetch(`/api/admin/kpis/${slug}/run${q}`)).json()) as {
      data: { point: { value: number } };
    }).data;

  test("without a row, a pinned KPI is still the collection-wide figure", async () => {
    expect((await run("revenue-per-product")).point.value).toBe(125);
  });

  test("with a row, it narrows through the named relation", async () => {
    expect((await run("revenue-per-product", `?rowId=${ids.widget}`)).point.value).toBe(25);
    expect((await run("revenue-per-product", `?rowId=${ids.gadget}`)).point.value).toBe(100);
  });

  test("a row with no matching lines is zero, not the whole collection", async () => {
    const fresh = await post(`/api/items/${products}`, { name: "unsold" });
    expect((await run("revenue-per-product", `?rowId=${fresh.json.data.id}`)).point.value).toBe(0);
  });

  test("rowId is ignored on a KPI that is not pinned", async () => {
    // The dangerous alternative is returning 125 under a heading that says
    // "widget" — a number nobody would think to doubt.
    expect((await run("unpinned-total", `?rowId=${ids.widget}`)).point.value).toBe(125);
  });

  test("the pin does not clobber the KPI's own filter", async () => {
    await post("/api/admin/kpis", {
      slug: "big-lines-per-product",
      name: "Big lines",
      collection: lines,
      agg: "sum",
      field: "amount",
      filter: { amount: { _gte: 12 } },
      pinTo: products,
      pinField: "product",
    });
    // widget has 10 and 15; only the 15 clears the filter.
    expect((await run("big-lines-per-product", `?rowId=${ids.widget}`)).point.value).toBe(15);
  });

  test("a half-configured pin is refused", async () => {
    const onlyTo = await post("/api/admin/kpis", {
      slug: "pin-a", name: "A", collection: lines, agg: "count", pinTo: products,
    });
    expect(onlyTo.status).toBe(422);
    const onlyField = await post("/api/admin/kpis", {
      slug: "pin-b", name: "B", collection: lines, agg: "count", pinField: "product",
    });
    expect(onlyField.status).toBe(422);
  });

  test("a pin naming a column the collection lacks fails loudly when run", async () => {
    await post("/api/admin/kpis", {
      slug: "bad-pin",
      name: "Bad pin",
      collection: lines,
      agg: "count",
      pinTo: products,
      pinField: "not_a_column",
    });
    const res = await h.fetch(`/api/admin/kpis/bad-pin/run?rowId=${ids.widget}`);
    // Not a silent collection-wide count under a row's heading.
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("not_a_column");
  });
});
