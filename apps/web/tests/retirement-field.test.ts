import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Row retirement — whether a row is still in play.
 *
 * The shape under test is the one 64 collections across 21 schema templates
 * carry: a boolean named `active`, defaulting to true, that nothing in the
 * product had ever read. Everything asserts through the REST surface, so the
 * narrowing predicate and the relation refusal are exercised exactly as a real
 * request emits them.
 */
describe("row retirement", () => {
  let h: TestHarness;

  const products = "ret_products";
  const orders = "ret_orders";
  const suppliers = "ret_suppliers";
  const plain = "ret_plain";

  const create = async (slug: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };
  const patch = async (slug: string, id: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}/${id}`, json(body, "PATCH"));
    return { status: r.status, body: (await r.json()) as any };
  };
  const retire = async (slug: string, id: string, qs = "") => {
    const r = await h.fetch(`/api/items/${slug}/${id}/retire${qs}`, json({}));
    return { status: r.status, body: (await r.json()) as any };
  };
  const names = async (slug: string, qs = "") => {
    const r = await h.fetch(`/api/items/${slug}?sort=name&limit=100${qs}`);
    return ((await r.json()).data as Record<string, any>[]).map((x) => x.name);
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug: products,
        fields: [
          { name: "name", type: "text" },
          { name: "active", type: "boolean", default: true, retire: {} },
        ],
      }),
    );
    // The other spelling: the flag says when the row is OUT, not in.
    await h.fetch(
      "/api/collections",
      json({
        slug: suppliers,
        fields: [
          { name: "name", type: "text" },
          {
            name: "discontinued",
            type: "boolean",
            default: false,
            retire: { retiredWhen: true, references: "allow" },
          },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: orders,
        fields: [
          { name: "name", type: "text" },
          { name: "product", type: "relation", to: products },
          { name: "supplier", type: "relation", to: suppliers },
          { name: "extras", type: "relation_many", to: products },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({ slug: plain, fields: [{ name: "name", type: "text" }] }),
    );
  });

  afterAll(async () => {
    await h.stop?.();
  });

  test("a collection may declare only one retirement flag", async () => {
    const r = await h.fetch(
      "/api/collections",
      json({
        slug: "ret_two_flags",
        fields: [
          { name: "active", type: "boolean", retire: {} },
          { name: "visible", type: "boolean", retire: {} },
        ],
      }),
    );
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).error?.message ?? "").toContain("one retirement flag");
  });

  test("the flag must be a boolean", async () => {
    const r = await h.fetch(
      "/api/collections",
      json({
        slug: "ret_bad_type",
        fields: [{ name: "state", type: "text", retire: {} }],
      }),
    );
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).error?.message ?? "").toContain("boolean");
  });

  test("the spec survives the round-trip through the collections API", async () => {
    const r = await h.fetch(`/api/collections/${products}`);
    const fields = ((await r.json()) as any).data.fields as any[];
    // The zod FieldSchema is a per-property ALLOW-LIST: an unlisted spec key is
    // dropped silently, and the only symptom is a feature that does nothing.
    expect(fields.find((f) => f.name === "active")?.retire).toEqual({});
  });

  test("declaring the flag indexes the column, without `indexed` being set", async () => {
    // All 64 catalog columns were unindexed, so every "only the live ones"
    // query was a scan. The declaration carries the index rather than asking
    // each schema to remember a second flag — this is the assertion that pins
    // it, since nothing else about the feature would fail if it were dropped.
    const r = await h.fetch(
      "/api/admin/db/sql/run",
      json({
        sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE '%ret_products%'",
      }),
    );
    const rows = (((await r.json()) as any).data ?? []).flatMap((s: any) => s.rows ?? []);
    const names = rows.map((x: any) => String(x.name));
    expect(names.some((n: string) => n.endsWith("_active_idx"))).toBe(true);
  });

  test("retirement does not hide a row from a read", async () => {
    const live = await create(products, { name: "live-widget", active: true });
    const gone = await create(products, { name: "gone-widget", active: false });
    expect(live.status).toBe(201);
    expect(gone.status).toBe(201);

    // The default is every row — an API consumer that has never heard of the
    // flag sees exactly what it saw yesterday.
    expect(await names(products)).toEqual(["gone-widget", "live-widget"]);
    // And by id, which is what an existing reference resolves through.
    const byId = await h.fetch(`/api/items/${products}/${gone.body.data.id}`);
    expect(byId.status).toBe(200);
  });

  test("?retired= narrows, and a NULL flag counts as in play", async () => {
    const unanswered = await create(products, { name: "null-widget", active: null });
    expect(unanswered.status).toBe(201);

    expect(await names(products, "&retired=exclude")).toEqual(["live-widget", "null-widget"]);
    expect(await names(products, "&retired=only")).toEqual(["gone-widget"]);
    expect(await names(products, "&retired=all")).toEqual([
      "gone-widget",
      "live-widget",
      "null-widget",
    ]);
  });

  test("an unrecognised ?retired= is refused, not silently widened", async () => {
    const r = await h.fetch(`/api/items/${products}?retired=excluded`);
    expect(r.status).toBe(422);
  });

  test("a collection with no flag: exclude is everything, only is nothing", async () => {
    await create(plain, { name: "a" });
    expect(await names(plain, "&retired=exclude")).toEqual(["a"]);
    expect(await names(plain, "&retired=only")).toEqual([]);
  });

  test("a new reference to a retired row is refused, naming the field", async () => {
    const gone = (await h.fetch(`/api/items/${products}?filter=${encodeURIComponent(
      JSON.stringify({ name: { _eq: "gone-widget" } }),
    )}`).then((r) => r.json())) as any;
    const goneId = gone.data[0].id as string;

    const r = await create(orders, { name: "o1", product: goneId });
    expect(r.status).toBe(422);
    expect(r.body.error?.message ?? "").toContain("product");
    expect(r.body.error?.message ?? "").toContain("retired");
  });

  test("relation_many is judged the same way", async () => {
    const rows = (await h.fetch(`/api/items/${products}?retired=only`).then((r) => r.json())) as any;
    const goneId = rows.data[0].id as string;
    const r = await create(orders, { name: "o2", extras: [goneId] });
    expect(r.status).toBe(422);
  });

  test("`references: allow` is the declared escape, and it works", async () => {
    const s = await create(suppliers, { name: "old-supplier", discontinued: true });
    const r = await create(orders, { name: "o3", supplier: s.body.data.id });
    expect(r.status).toBe(201);
  });

  test("an EXISTING reference is never re-validated", async () => {
    const p = await create(products, { name: "soon-gone", active: true });
    const o = await create(orders, { name: "o4", product: p.body.data.id });
    expect(o.status).toBe(201);

    const gone = await retire(products, p.body.data.id);
    expect(gone.status).toBe(200);
    expect(gone.body.retired).toBe(true);

    // The order still resolves it, and a PATCH that does not name the relation
    // is not judged by it. This is the whole reason retirement is not deletion.
    const still = await h.fetch(`/api/items/${orders}/${o.body.data.id}`);
    expect(still.status).toBe(200);
    expect(((await still.json()) as any).data.product).toBe(p.body.data.id);
    const renamed = await patch(orders, o.body.data.id, { name: "o4-renamed" });
    expect(renamed.status).toBe(200);
  });

  test("retire and restore round-trip through the ordinary write path", async () => {
    const p = await create(products, { name: "round-trip", active: true });
    const id = p.body.data.id as string;

    const off = await retire(products, id);
    expect(off.status).toBe(200);
    expect(off.body.field).toBe("active");
    expect(off.body.data.active).toBe(false);

    const on = await retire(products, id, "?restore=1");
    expect(on.status).toBe(200);
    expect(on.body.retired).toBe(false);
    expect(on.body.data.active).toBe(true);

    // A revision was recorded for each — the verb goes through performUpdate
    // precisely so revisions, activity, realtime and flows are not skipped.
    const revs = (await h
      .fetch(`/api/revisions/${products}/${id}`)
      .then((r) => r.json())) as any;
    expect((revs.data ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("the other spelling retires by writing true, not false", async () => {
    const s = await create(suppliers, { name: "flip", discontinued: false });
    const off = await retire(suppliers, s.body.data.id);
    expect(off.body.data.discontinued).toBe(true);
    const on = await retire(suppliers, s.body.data.id, "?restore=1");
    expect(on.body.data.discontinued).toBe(false);
  });

  test("retiring in a collection with no flag is refused, not a silent ok", async () => {
    const a = await create(plain, { name: "b" });
    const r = await retire(plain, a.body.data.id);
    expect(r.status).toBe(422);
    expect(r.body.error?.message ?? "").toContain("no retirement flag");
  });
});
