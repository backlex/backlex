import { describe, expect, test, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Sequence fields — the document number the server issues.
 *
 * The shape under test is the one 17 of the 27 schema templates carry by hand:
 * a `required + unique` `INV-…` / `PO-…` number that, before this, the caller
 * had to invent. Everything asserts through the REST surface so the allocation
 * runs exactly as a real write drives it.
 */
describe("sequence fields", () => {
  let h: TestHarness;

  const invoices = "seq_invoices";
  const orders = "seq_orders";
  const quotes = "seq_quotes";

  const create = async (slug: string, body: unknown = {}) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };
  const read = async (slug: string, id: string) =>
    (await (await h.fetch(`/api/items/${slug}/${id}`)).json()).data as Record<string, any>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug: invoices,
        fields: [
          { name: "title", type: "text" },
          {
            name: "number",
            type: "text",
            required: true,
            unique: true,
            sequence: { pattern: "INV-{####}" },
          },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: orders,
        fields: [
          { name: "note", type: "text" },
          { name: "number", type: "text", sequence: { pattern: "ORD-{###}", start: 1001 } },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: quotes,
        fields: [
          {
            name: "number",
            type: "text",
            sequence: { pattern: "Q-{YYYY}-{###}", reset: "yearly", timezone: "UTC" },
          },
        ],
      }),
    );
  });

  test("issues a rendered, padded number on create", async () => {
    const a = await create(invoices, { title: "first" });
    expect(a.status).toBe(201);
    expect(a.body.data.number).toBe("INV-0001");
    const b = await create(invoices, { title: "second" });
    expect(b.body.data.number).toBe("INV-0002");
    // The value in the response is the value that was stored — a client that
    // just created an invoice can show its number without re-reading.
    expect((await read(invoices, a.body.data.id)).number).toBe("INV-0001");
  });

  test("`start` sets the first number in a fresh series", async () => {
    const a = await create(orders, { note: "x" });
    expect(a.body.data.number).toBe("ORD-1001");
    const b = await create(orders, { note: "y" });
    expect(b.body.data.number).toBe("ORD-1002");
  });

  test("a required sequence field is not required FROM the caller", async () => {
    // `number` is `required: true`, but the server fills it — an empty body
    // must still create rather than 422 on a column the caller cannot write.
    const r = await create(invoices, {});
    expect(r.status).toBe(201);
    expect(r.body.data.number).toMatch(/^INV-\d{4}$/);
  });

  test("client writes are refused on create and on update", async () => {
    const refused = await create(invoices, { title: "t", number: "INV-9999" });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.message ?? refused.body.message).toContain("sequence");

    const made = await create(invoices, { title: "t" });
    const patched = await h.fetch(
      `/api/items/${invoices}/${made.body.data.id}`,
      json({ number: "INV-0001" }, "PATCH"),
    );
    // A document number that can be edited after the fact is not a document
    // number — and an edited value would collide with one still to be issued.
    expect(patched.status).toBe(422);
  });

  test("the year token renders and the counter buckets by period", async () => {
    const a = await create(quotes);
    const year = new Date().getUTCFullYear();
    expect(a.body.data.number).toBe(`Q-${year}-001`);
    const b = await create(quotes);
    expect(b.body.data.number).toBe(`Q-${year}-002`);
  });

  test("concurrent creates never share a number", async () => {
    const n = 25;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => create(invoices, { title: `c${i}` })),
    );
    const numbers = results.map((r) => r.body.data.number as string);
    expect(numbers.filter(Boolean)).toHaveLength(n);
    // The guarantee is uniqueness, not contiguity — assert exactly that.
    expect(new Set(numbers).size).toBe(n);
  });

  test("a rejected payload does not burn a number", async () => {
    const before = (await create(invoices, { title: "before" })).body.data.number as string;
    // Unknown field → 422 in the validation phase, which runs before the
    // counter is touched.
    const bad = await create(invoices, { nope: 1 });
    expect(bad.status).toBe(422);
    const after = (await create(invoices, { title: "after" })).body.data.number as string;
    const seq = (v: string) => Number(v.slice(4));
    expect(seq(after)).toBe(seq(before) + 1);
  });

  test("a batch takes one block and numbers every row", async () => {
    const r = await h.fetch(
      `/api/items/${orders}/batch`,
      json({
        operations: [
          { op: "create", data: { note: "a" } },
          { op: "create", data: { note: "b" } },
          { op: "create", data: { note: "c" } },
        ],
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    const nums = body.data.results.map((x: any) => x.data.number as string);
    expect(new Set(nums).size).toBe(3);
    const seq = nums.map((v: string) => Number(v.slice(4))).sort((a: number, b: number) => a - b);
    // Drawn from one contiguous allocated block.
    expect(seq[1]).toBe(seq[0] + 1);
    expect(seq[2]).toBe(seq[1] + 1);
  });

  test("a bad spec is refused at save time, not at write time", async () => {
    const cases: [string, unknown][] = [
      ["no counter token", { pattern: "INV-2026" }],
      ["reset with no date token", { pattern: "INV-{###}", reset: "yearly" }],
      ["unknown token", { pattern: "INV-{YYY}-{###}" }],
      ["two counters", { pattern: "{##}-{##}" }],
    ];
    for (const [label, spec] of cases) {
      const r = await h.fetch(
        "/api/collections",
        json({
          slug: `seq_bad_${label.replace(/\W+/g, "_")}`,
          fields: [{ name: "number", type: "text", sequence: spec }],
        }),
      );
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("a sequence must be a text field", async () => {
    const r = await h.fetch(
      "/api/collections",
      json({
        slug: "seq_wrong_type",
        fields: [{ name: "number", type: "integer", sequence: { pattern: "{###}" } }],
      }),
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
