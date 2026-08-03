import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Rollup fields — a parent number maintained from its children.
 *
 * The shape under test is the one 18 of the 26 schema templates carry by hand:
 * an invoice with line items, where `subtotal` is the sum of the lines and
 * nothing kept it honest. Everything asserts through the REST surface, so the
 * refresh statements are exercised exactly as a real write emits them.
 */
describe("rollup fields", () => {
  let h: TestHarness;

  const invoices = "rollup_invoices";
  const lines = "rollup_lines";

  const create = async (slug: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };
  const patch = async (slug: string, id: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}/${id}`, json(body, "PATCH"));
    return { status: r.status, body: (await r.json()) as any };
  };
  const read = async (slug: string, id: string) =>
    (await (await h.fetch(`/api/items/${slug}/${id}`)).json()).data as Record<string, any>;

  const newInvoice = async () => (await create(invoices, { number: `INV-${crypto.randomUUID().slice(0, 8)}` })).body.data.id as string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // The child must exist before the parent can name it — a rollup is
    // validated against the collection it aggregates.
    await h.fetch(
      "/api/collections",
      json({
        slug: lines,
        fields: [
          { name: "description", type: "text" },
          { name: "invoice", type: "relation", to: invoices },
          { name: "amount", type: "number" },
          { name: "status", type: "text" },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: invoices,
        fields: [
          { name: "number", type: "text" },
          {
            name: "subtotal",
            type: "number",
            rollup: { from: lines, via: "invoice", fn: "sum", field: "amount" },
          },
          {
            name: "line_count",
            type: "integer",
            rollup: { from: lines, via: "invoice", fn: "count" },
          },
          {
            name: "billable",
            type: "number",
            rollup: {
              from: lines,
              via: "invoice",
              fn: "sum",
              field: "amount",
              filter: { status: { _eq: "billable" } },
            },
          },
          {
            name: "largest_line",
            type: "number",
            rollup: { from: lines, via: "invoice", fn: "max", field: "amount" },
          },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("a parent with no children reads the neutral value for its aggregate", async () => {
    const id = await newInvoice();
    const row = await read(invoices, id);
    // count/sum over nothing is 0 — a total of no rows is zero, not unknown.
    expect(row.subtotal).toBe(0);
    expect(row.line_count).toBe(0);
    // max over nothing is genuinely undefined and stays null.
    expect(row.largest_line ?? null).toBeNull();
  });

  test("creating children moves the parent's totals", async () => {
    const id = await newInvoice();
    await create(lines, { invoice: id, amount: 100, status: "billable" });
    await create(lines, { invoice: id, amount: 250, status: "billable" });
    await create(lines, { invoice: id, amount: 30, status: "internal" });

    const row = await read(invoices, id);
    expect(row.subtotal).toBe(380);
    expect(row.line_count).toBe(3);
    expect(row.largest_line).toBe(250);
    // The filtered rollup counts only the billable lines.
    expect(row.billable).toBe(350);
  });

  test("updating a child's aggregated value restates the parent", async () => {
    const id = await newInvoice();
    const line = (await create(lines, { invoice: id, amount: 100, status: "billable" })).body.data.id;
    expect((await read(invoices, id)).subtotal).toBe(100);

    await patch(lines, line, { amount: 175 });
    expect((await read(invoices, id)).subtotal).toBe(175);
  });

  test("a child moving between parents debits one and credits the other", async () => {
    const a = await newInvoice();
    const b = await newInvoice();
    const line = (await create(lines, { invoice: a, amount: 90, status: "billable" })).body.data.id;
    expect((await read(invoices, a)).subtotal).toBe(90);
    expect((await read(invoices, b)).subtotal).toBe(0);

    await patch(lines, line, { invoice: b });
    // Both sides refresh — the money has to leave A, not just arrive at B.
    expect((await read(invoices, a)).subtotal).toBe(0);
    expect((await read(invoices, a)).line_count).toBe(0);
    expect((await read(invoices, b)).subtotal).toBe(90);
    expect((await read(invoices, b)).line_count).toBe(1);
  });

  test("a filtered rollup follows a child crossing the filter boundary", async () => {
    const id = await newInvoice();
    const line = (await create(lines, { invoice: id, amount: 500, status: "internal" })).body.data.id;
    expect((await read(invoices, id)).billable).toBe(0);
    expect((await read(invoices, id)).subtotal).toBe(500);

    await patch(lines, line, { status: "billable" });
    expect((await read(invoices, id)).billable).toBe(500);
  });

  test("deleting a child takes its contribution back off the parent", async () => {
    const id = await newInvoice();
    const keep = (await create(lines, { invoice: id, amount: 40, status: "billable" })).body.data.id;
    const drop = (await create(lines, { invoice: id, amount: 60, status: "billable" })).body.data.id;
    expect((await read(invoices, id)).subtotal).toBe(100);

    await h.fetch(`/api/items/${lines}/${drop}`, { method: "DELETE" });
    const row = await read(invoices, id);
    expect(row.subtotal).toBe(40);
    expect(row.line_count).toBe(1);
    expect(row.largest_line).toBe(40);
    expect(keep).toBeTruthy();
  });

  test("a rollup column is read-only to callers", async () => {
    const id = await newInvoice();
    const direct = await patch(invoices, id, { subtotal: 999_999 });
    expect(direct.status).toBe(422);
    expect(String(direct.body.error?.message ?? "")).toContain("rollup");
    // And the stored number is untouched.
    expect((await read(invoices, id)).subtotal).toBe(0);
  });

  test("adding a rollup to a collection that already has rows backfills it", async () => {
    const id = await newInvoice();
    await create(lines, { invoice: id, amount: 12, status: "billable" });
    await create(lines, { invoice: id, amount: 8, status: "internal" });

    // A rollup added AFTER the rows exist: without a backfill the new column
    // would read its DDL default (0) — confidently wrong rather than missing.
    const r = await h.fetch(
      `/api/collections/${invoices}`,
      json(
        {
          fields: [
            { name: "number", type: "text" },
            { name: "subtotal", type: "number", rollup: { from: lines, via: "invoice", fn: "sum", field: "amount" } },
            { name: "line_count", type: "integer", rollup: { from: lines, via: "invoice", fn: "count" } },
            { name: "billable", type: "number", rollup: { from: lines, via: "invoice", fn: "sum", field: "amount", filter: { status: { _eq: "billable" } } } },
            { name: "largest_line", type: "number", rollup: { from: lines, via: "invoice", fn: "max", field: "amount" } },
            { name: "avg_line", type: "number", rollup: { from: lines, via: "invoice", fn: "avg", field: "amount" } },
          ],
        },
        "PATCH",
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.rollupBackfill).toContain("avg_line");

    expect((await read(invoices, id)).avg_line).toBe(10);
  });
});

describe("rollup field validation", () => {
  let h: TestHarness;
  const parent = "rv_parent";
  const child = "rv_child";

  const mkCollection = async (body: unknown) => {
    const r = await h.fetch("/api/collections", json(body));
    return { status: r.status, message: String(((await r.json()) as any).error?.message ?? "") };
  };
  const rollupField = (rollup: unknown, type = "number") => ({
    slug: `rv_${crypto.randomUUID().slice(0, 8)}`,
    fields: [{ name: "total", type, rollup }],
  });
  /**
   * Declare a rollup on the collection `rv_child.owner` actually points at, so
   * the check under test is the one that fires. Aimed at a fresh slug instead,
   * every case would trip the "via points elsewhere" guard first and pass for
   * the wrong reason.
   */
  const onRealParent = async (rollup: unknown, type = "number") => {
    const r = await h.fetch(
      `/api/collections/${parent}`,
      json({ fields: [{ name: "name", type: "text" }, { name: "total", type, rollup }] }, "PATCH"),
    );
    return { status: r.status, message: String(((await r.json()) as any).error?.message ?? "") };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug: child,
        fields: [
          { name: "owner", type: "relation", to: parent },
          { name: "tags", type: "relation_many", to: parent },
          { name: "amount", type: "number" },
          { name: "label", type: "text" },
        ],
      }),
    );
    await h.fetch("/api/collections", json({ slug: parent, fields: [{ name: "name", type: "text" }] }));
  });
  afterAll(() => h.cleanup());

  test("rejects a rollup over a collection that does not exist", async () => {
    const r = await mkCollection(rollupField({ from: "nope_missing", via: "owner", fn: "sum", field: "amount" }));
    expect(r.status).toBe(422);
    expect(r.message).toContain("does not exist");
  });

  test("rejects a `via` that is not a field on the child", async () => {
    const r = await mkCollection(rollupField({ from: child, via: "not_a_field", fn: "count" }));
    expect(r.status).toBe(422);
    expect(r.message).toContain("no field");
  });

  test("rejects a `via` that points at a different collection", async () => {
    const r = await mkCollection(rollupField({ from: child, via: "owner", fn: "count" }));
    expect(r.status).toBe(422);
    // `owner` points at rv_parent, not at the randomly-named collection above.
    expect(r.message).toContain("points at");
  });

  test("rejects relation_many as the `via` — it holds a list, not one parent", async () => {
    const r = await h.fetch(
      "/api/collections",
      json({ slug: parent + "_x", fields: [{ name: "n", type: "number", rollup: { from: child, via: "tags", fn: "count" } }] }),
    );
    expect(r.status).toBe(422);
    expect(String(((await r.json()) as any).error?.message ?? "")).toContain("relation_many");
  });

  test("rejects aggregating a non-numeric child field", async () => {
    const r = await onRealParent({ from: child, via: "owner", fn: "sum", field: "label" });
    expect(r.status).toBe(422);
    expect(r.message).toContain("needs a number");
  });

  test("rejects `avg` on an integer column — it would truncate", async () => {
    const r = await mkCollection(rollupField({ from: child, via: "owner", fn: "avg", field: "amount" }, "integer"));
    expect(r.status).toBe(422);
    expect(r.message).toContain("truncate");
  });

  test("rejects a rollup on a non-numeric column", async () => {
    const r = await mkCollection(rollupField({ from: child, via: "owner", fn: "count" }, "text"));
    expect(r.status).toBe(422);
    expect(r.message).toContain("integer or number");
  });

  test("rejects a filter that depends on who triggered the refresh", async () => {
    const r = await mkCollection(
      rollupField({ from: child, via: "owner", fn: "count", filter: { label: { _eq: "$user.email" } } }),
    );
    expect(r.status).toBe(422);
    expect(r.message).toContain("$user.email");
  });

  test("rejects a filter naming a field the child does not have", async () => {
    const r = await onRealParent({ from: child, via: "owner", fn: "count", filter: { ghost: { _eq: "x" } } }, "integer");
    expect(r.status).toBe(422);
    expect(r.message).toContain("ghost");
  });

  test("accepts a well-formed rollup on the collection the relation points at", async () => {
    const r = await onRealParent({ from: child, via: "owner", fn: "sum", field: "amount" });
    expect(r.status).toBe(200);
  });

  test("rejects `count` carrying a field, and a non-count missing one", async () => {
    expect((await mkCollection(rollupField({ from: child, via: "owner", fn: "count", field: "amount" }))).status).toBe(422);
    expect((await mkCollection(rollupField({ from: child, via: "owner", fn: "sum" }))).status).toBe(422);
  });

  test("rejects a rollup over its own collection", async () => {
    const slug = `rv_${crypto.randomUUID().slice(0, 8)}`;
    const r = await h.fetch(
      "/api/collections",
      json({ slug, fields: [{ name: "n", type: "integer", rollup: { from: slug, via: "owner", fn: "count" } }] }),
    );
    expect(r.status).toBe(422);
    expect(String(((await r.json()) as any).error?.message ?? "")).toContain("its own collection");
  });

  test("rejects flags that imply a second writer of the column", async () => {
    for (const extra of [{ required: true }, { unique: true }, { default: 5 }, { onUpdate: "now" }, { localized: true }]) {
      const r = await h.fetch(
        "/api/collections",
        json({
          slug: `rv_${crypto.randomUUID().slice(0, 8)}`,
          fields: [{ name: "n", type: "integer", rollup: { from: child, via: "owner", fn: "count" }, ...extra }],
        }),
      );
      expect(r.status).toBe(422);
    }
  });
});
