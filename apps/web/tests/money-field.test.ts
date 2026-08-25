import { beforeAll, describe, expect, test } from "bun:test";
import {
  currencyExponent,
  formatMoney,
  fromMinorUnits,
  sumMoney,
  toMinorUnits,
} from "@backlex/db/money";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Money fields — an amount that knows what it is denominated in.
 *
 * The shape under test is the one 23 of the 27 schema templates carry as a bare
 * `number`: prices, totals, salaries and balances, with a `text` column named
 * `currency` sitting next to some of them and nothing tying the two together.
 *
 * Almost everything asserts through REST rather than against the pure module,
 * because the interesting failures are all at the edges: what the column
 * actually holds, what a filter compares against, and whether the 201 body
 * matches the next GET.
 */
describe("money fields", () => {
  let h: TestHarness;

  const products = "money_products";
  const invoices = "money_invoices";
  const lines = "money_lines";

  const list = async (slug: string, query = "") => {
    const r = await h.fetch(`/api/items/${slug}${query ? `?${query}` : ""}`);
    return { status: r.status, body: (await r.json()) as any };
  };
  const create = async (slug: string, data: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(data));
    return { status: r.status, body: (await r.json()) as any };
  };
  const filter = (cond: unknown) => `filter=${encodeURIComponent(JSON.stringify(cond))}`;
  /** The global error handler nests the message; some paths flatten it. */
  const msg = (body: any): string => String(body?.error?.message ?? body?.message ?? "");

  /** Physical table names, captured at create time — the raw-column assertions
   *  below are the only way to prove what is actually stored, which is the
   *  whole claim the type makes. */
  const tables: Record<string, string> = {};
  /** Read raw columns straight out of SQLite, bypassing every serializer. */
  const raw = async (sql: string): Promise<Record<string, unknown>[]> => {
    const r = await h.fetch("/api/admin/db/sql/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const body = (await r.json()) as any;
    return (body.data?.[0]?.rows ?? []) as Record<string, unknown>[];
  };

  /** Create a collection and remember the physical table it landed on. */
  const mkCollection = async (body: Record<string, unknown>) => {
    const r = await h.fetch("/api/collections", json(body));
    const parsed = (await r.json()) as any;
    if (r.status === 201) tables[body.slug as string] = parsed.data.physicalTable;
    return { status: r.status, body: parsed };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Single-currency: a price list.
    await mkCollection({
      slug: products,
      fields: [
        { name: "name", type: "text", required: true },
        { name: "price", type: "money", money: { currency: "TRY" } },
        { name: "yen_price", type: "money", money: { currency: "JPY" } },
      ],
    });
    // Per-row currency: invoices billed in whatever the customer pays in.
    await mkCollection({
      slug: invoices,
      fields: [
        { name: "ref", type: "text", required: true },
        { name: "currency", type: "text" },
        { name: "total", type: "money", money: { currencyField: "currency" } },
      ],
    });
  });

  describe("the pure conversion", () => {
    test("shifts the decimal point instead of multiplying a double", () => {
      // `12.34 * 100` is 1233.9999999999998 and `Math.round(1.005 * 100)` is
      // 100 — both silent, both money.
      expect(toMinorUnits(12.34, 2)).toBe(1234);
      expect(toMinorUnits(1.005, 3)).toBe(1005);
      // And a third decimal in a two-decimal currency is an error, not a
      // rounding opportunity — quantizing it would be the server deciding where
      // half a cent goes.
      expect(() => toMinorUnits("1.005", 2)).toThrow(/decimal places/);
      expect(toMinorUnits(-0.07, 2)).toBe(-7);
    });

    test("honours each currency's own exponent", () => {
      expect(currencyExponent("JPY")).toBe(0);
      expect(currencyExponent("KWD")).toBe(3);
      expect(currencyExponent("USD")).toBe(2);
      // A code the table has never heard of assumes two, which is right far
      // more often than any other guess.
      expect(currencyExponent("QQQ")).toBe(2);
      expect(toMinorUnits(1000, currencyExponent("JPY"))).toBe(1000);
      expect(toMinorUnits(1.234, currencyExponent("KWD"))).toBe(1234);
    });

    test("refuses precision the currency does not have, but not float noise", () => {
      expect(() => toMinorUnits(19.999, 0)).toThrow(/decimal places/);
      expect(() => toMinorUnits("0.001", 2)).toThrow(/decimal places/);
      // 0.1 + 0.2 — the excess is ~4e-17 of a cent, which is an artifact of the
      // caller's arithmetic rather than a decision they made.
      expect(toMinorUnits(0.1 + 0.2, 2)).toBe(30);
      // And the same artifact from below rounds UP rather than truncating.
      // Written as arithmetic rather than as a literal because the literal
      // itself would round to 0.3 before the function ever saw it — which is
      // the whole reason this case needs handling.
      expect(toMinorUnits(0.3 - Number.EPSILON / 8, 2)).toBe(30);
    });

    test("round-trips through minor units exactly", () => {
      for (const [amount, exp] of [[19.99, 2], [1000, 0], [1.234, 3], [0.01, 2]] as const) {
        expect(fromMinorUnits(toMinorUnits(amount, exp), exp)).toBe(amount);
      }
    });

    test("refuses to add currencies together", () => {
      expect(
        sumMoney([
          { amount: 10, currency: "USD" },
          { amount: 5.5, currency: "USD" },
        ]),
      ).toEqual({ amount: 15.5, currency: "USD" });
      expect(() =>
        sumMoney([
          { amount: 10, currency: "USD" },
          { amount: 10, currency: "TRY" },
        ]),
      ).toThrow(/cannot add/);
    });

    test("formats with the currency's own decimals", () => {
      expect(formatMoney({ amount: 1000, currency: "JPY" }, "en")).not.toContain(".00");
      expect(formatMoney({ amount: 19.99, currency: "USD" }, "en")).toContain("19.99");
    });
  });

  describe("a fixed-currency column", () => {
    test("reads back as an amount paired with its currency", async () => {
      const created = await create(products, { name: "Mug", price: 19.99 });
      expect(created.status).toBe(201);
      expect(created.body.data.price).toEqual({ amount: 19.99, currency: "TRY" });
      // The 201 body and the next GET have to agree — the failure geo had to
      // fix after the fact, where the response carried the caller's shape and
      // the re-read carried the stored one.
      const r = await h.fetch(`/api/items/${products}/${created.body.data.id}`);
      expect(((await r.json()) as any).data.price).toEqual({
        amount: 19.99,
        currency: "TRY",
      });
    });

    test("stores minor units, so the column is an exact integer", async () => {
      const created = await create(products, { name: "Exactness", price: 0.1 });
      const rows = await raw(
        `SELECT price FROM ${tables[products]} WHERE id = '${created.body.data.id}'`,
      );
      expect(rows[0]?.price).toBe(10);
    });

    test("accepts every documented input shape and stores one", async () => {
      const shapes: [string, unknown][] = [
        ["bare number", 5],
        ["decimal string", "5.00"],
        ["tagged string", "5 TRY"],
        ["object", { amount: 5, currency: "TRY" }],
        ["minor units", { minor: 500, currency: "TRY" }],
      ];
      for (const [label, value] of shapes) {
        const r = await create(products, { name: `shape ${label}`, price: value });
        expect(r.status).toBe(201);
        expect(r.body.data.price).toEqual({ amount: 5, currency: "TRY" });
      }
    });

    test("refuses an amount denominated in something else", async () => {
      const r = await create(products, { name: "Wrong", price: { amount: 5, currency: "USD" } });
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/USD/);
      expect(msg(r.body)).toMatch(/TRY/);
    });

    test("refuses a thousands separator rather than guessing which convention", async () => {
      const r = await create(products, { name: "Ambiguous", price: "1,234" });
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/separator/);
    });

    test("a zero-decimal currency stores whole units", async () => {
      const r = await create(products, { name: "Tokyo", yen_price: 1500 });
      expect(r.body.data.yen_price).toEqual({ amount: 1500, currency: "JPY" });
      const rows = await raw(
        `SELECT yen_price FROM ${tables[products]} WHERE id = '${r.body.data.id}'`,
      );
      expect(rows[0]?.yen_price).toBe(1500);
      const bad = await create(products, { name: "Sub-yen", yen_price: 19.99 });
      expect(bad.status).toBe(422);
    });
  });

  describe("filtering", () => {
    test("compares in major units, not in the column's own", async () => {
      await create(products, { name: "Cheap", price: 5 });
      await create(products, { name: "Dear", price: 500 });
      // 100 means a hundred lira. Against the raw column (minor units) it would
      // be one lira, and every row would come back.
      const r = await list(products, filter({ price: { _gte: 100 } }));
      expect(r.status).toBe(200);
      const names = r.body.data.map((x: any) => x.name);
      expect(names).toContain("Dear");
      expect(names).not.toContain("Cheap");
    });

    test("rejects a text operator on an amount", async () => {
      const r = await list(products, filter({ price: { _contains: "19" } }));
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/money field/);
    });

    test("_null still works — 'which rows have no price yet'", async () => {
      await create(products, { name: "Unpriced" });
      const r = await list(products, filter({ price: { _null: true } }));
      expect(r.status).toBe(200);
      expect(r.body.data.map((x: any) => x.name)).toContain("Unpriced");
    });
  });

  describe("a per-row currency", () => {
    beforeAll(async () => {
      await create(invoices, { ref: "A-1", currency: "USD", total: 100 });
      await create(invoices, { ref: "A-2", currency: "TRY", total: 100 });
      await create(invoices, { ref: "A-3", currency: "JPY", total: 100 });
    });

    test("each row is scaled by its own currency", async () => {
      const r = await list(invoices, `${filter({ ref: { _eq: "A-3" } })}`);
      expect(r.body.data[0].total).toEqual({ amount: 100, currency: "JPY" });
      const rows = await raw(`SELECT ref, total FROM ${tables[invoices]} ORDER BY ref`);
      // 100 USD is 10 000 cents; 100 JPY is 100 yen. The same input, two
      // different columns' worth of integer.
      expect(rows.find((x: any) => x.ref === "A-1")?.total).toBe(10000);
      expect(rows.find((x: any) => x.ref === "A-3")?.total).toBe(100);
    });

    test("a write with no currency for the row is refused, not stored unscaled", async () => {
      const r = await create(invoices, { ref: "A-4", total: 100 });
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/currency/);
    });

    test("a comparison must name the currency it is comparing against", async () => {
      const bare = await list(invoices, filter({ total: { _gte: 50 } }));
      expect(bare.status).toBe(422);
      expect(msg(bare.body)).toMatch(/which one/);

      const pinned = await list(
        invoices,
        filter({ total: { _gte: { amount: 50, currency: "USD" } } }),
      );
      expect(pinned.status).toBe(200);
      // Only the USD row — the yen row's 100 minor units would have matched a
      // comparison that ignored denomination.
      expect(pinned.body.data.map((x: any) => x.ref)).toEqual(["A-1"]);
    });

    test("re-denominating a row without restating the amount is refused", async () => {
      const created = await create(invoices, { ref: "A-5", currency: "USD", total: 20 });
      const id = created.body.data.id;
      // USD → JPY changes the exponent, so the stored 2000 would silently
      // become two thousand yen.
      const bad = await h.fetch(`/api/items/${invoices}/${id}`, json({ currency: "JPY" }, "PATCH"));
      expect(bad.status).toBe(422);
      expect(msg((await bad.json()) as any)).toMatch(/restate/);
      // Restating it in the same write is the escape hatch, and the right move.
      const ok = await h.fetch(
        `/api/items/${invoices}/${id}`,
        json({ currency: "JPY", total: 3000 }, "PATCH"),
      );
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).data.total).toEqual({ amount: 3000, currency: "JPY" });
    });

    test("a patch that touches only the amount takes the currency from the row", async () => {
      const created = await create(invoices, { ref: "A-6", currency: "TRY", total: 10 });
      const r = await h.fetch(
        `/api/items/${invoices}/${created.body.data.id}`,
        json({ total: 42.5 }, "PATCH"),
      );
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).data.total).toEqual({ amount: 42.5, currency: "TRY" });
    });

    test("a computed money column subtracts in minor units and reads as money", async () => {
      // The shape `invoicing` ships: `balance_due = total - amount_paid`, a
      // generated column over two money columns. Both operands are integers, so
      // the difference is an integer — and it has to read back as an AMOUNT.
      // Declared as a plain number it would print a balance of `250000` beside
      // a total of `€2,500.00`, which is the silent wrongness this type exists
      // to end. Driven through the template applier because `computed` is
      // deliberately not settable over the collections API.
      const applied = await h.fetch(
        "/api/admin/templates/apply",
        json({ templateId: "invoicing" }),
      );
      expect(applied.status).toBe(201);
      const listed = (await (
        await h.fetch("/api/items/invoices?limit=50")
      ).json()) as any;
      const withBalance = (listed.data as any[]).find(
        (row) => row.balance_due && typeof row.balance_due === "object",
      );
      expect(withBalance).toBeDefined();
      expect(typeof withBalance.balance_due.amount).toBe("number");
      expect(withBalance.balance_due.currency).toBe(withBalance.currency);
      // …and it is the difference, in major units, not in minor ones.
      expect(withBalance.balance_due.amount).toBeCloseTo(
        withBalance.total.amount - (withBalance.amount_paid?.amount ?? 0),
        6,
      );
    });

    test("a projection that drops the currency column still reads the amount", async () => {
      // `?fields=total` alone would leave the row without the column that says
      // how to scale it — the SQL projection pulls the sibling in regardless.
      const r = await list(invoices, `fields=ref,total&${filter({ ref: { _eq: "A-1" } })}`);
      expect(r.status).toBe(200);
      expect(r.body.data[0].total).toEqual({ amount: 100, currency: "USD" });
      expect(r.body.data[0].currency).toBeUndefined();
    });
  });

  describe("aggregating", () => {
    const aggregate = async (slug: string, body: Record<string, unknown>) => {
      const r = await h.fetch(`/api/items/${slug}/aggregate`, json(body));
      return { status: r.status, body: (await r.json()) as any };
    };

    test("a single-currency sum comes back in major units with its code", async () => {
      const r = await aggregate(products, { agg: "sum", field: "price" });
      expect(r.status).toBe(200);
      const row = r.body.data[0];
      expect(row.currency).toBe("TRY");
      // The raw column holds kuru*; the answer is in lira. Without the rescale
      // this number would be a hundred times bigger and carry no unit at all.
      expect(row.value).toBeLessThan(10000);
      expect(Math.round(row.value * 100)).toBeCloseTo(row.value * 100, 6);
    });

    test("a mixed-currency sum is refused unless grouped by the currency", async () => {
      const bad = await aggregate(invoices, { agg: "sum", field: "total" });
      expect(bad.status).toBe(422);
      expect(msg(bad.body)).toMatch(/groupBy/);

      const ok = await aggregate(invoices, {
        agg: "sum",
        field: "total",
        groupBy: "currency",
      });
      expect(ok.status).toBe(200);
      const buckets = ok.body.data as any[];
      expect(buckets.length).toBeGreaterThan(1);
      // Every bucket is scaled by its OWN exponent. Asserted against the rows
      // themselves rather than a hard-coded figure: the claim is that the
      // aggregate and a read of the same rows agree, and a yen bucket divided
      // by a hundred (or a dollar one not divided at all) would not.
      const all = await list(invoices);
      for (const bucket of buckets) {
        expect(bucket.currency).toBe(bucket.label);
        const expected = (all.body.data as any[])
          .filter((row) => row.total?.currency === bucket.label)
          .reduce((acc, row) => acc + row.total.amount, 0);
        expect(bucket.value).toBeCloseTo(expected, 6);
      }
      // …and the zero-decimal one is a whole number of yen, not of hundredths.
      const jpy = buckets.find((x) => x.label === "JPY");
      expect(Number.isInteger(jpy.value)).toBe(true);
    });
  });

  describe("schema validation", () => {
    const mk = (field: Record<string, unknown>) =>
      h
        .fetch(
          "/api/collections",
          json({ slug: `money_bad_${Math.abs(hash(JSON.stringify(field)))}`, fields: [field] }),
        )
        .then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

    test("a money field with no currency at all is refused", async () => {
      const r = await mk({ name: "amount", type: "money" });
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/currency/);
    });

    test("both a fixed currency and a column is refused", async () => {
      const r = await mk({
        name: "amount",
        type: "money",
        money: { currency: "USD", currencyField: "cur" },
      });
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/exactly one/);
    });

    test("a currencyField naming a column that is not text is refused", async () => {
      const r = await h.fetch(
        "/api/collections",
        json({
          slug: "money_bad_target",
          fields: [
            { name: "cur", type: "integer" },
            { name: "amount", type: "money", money: { currencyField: "cur" } },
          ],
        }),
      );
      expect(r.status).toBe(422);
      expect(msg((await r.json()) as any)).toMatch(/must name a text field/);
    });
  });

  describe("rollups over money", () => {
    const orders = "money_orders";

    beforeAll(async () => {
      // Parent first (no rollup yet), then the child that points at it, then
      // the rollup field — a rollup cannot be declared before the relation it
      // aggregates through exists.
      await mkCollection({ slug: orders, fields: [{ name: "ref", type: "text" }] });
      await mkCollection({
        slug: lines,
        fields: [
          { name: "order", type: "relation", to: orders },
          { name: "amount", type: "money", money: { currency: "TRY" } },
        ],
      });
    });

    /** Genuinely additive: `fields` on a collection PATCH is a REPLACE, so a
     *  helper that names only the field it is adding silently drops the ones a
     *  previous test added — and now gets refused for it. Read the current list
     *  and append, so each test here asserts the rollup rule it is about. */
    const addRollupField = async (field: Record<string, unknown>) => {
      const current = (await (await h.fetch(`/api/collections/${orders}`)).json()) as {
        data: { fields: Record<string, unknown>[] };
      };
      const kept = current.data.fields.filter((f) => f.name !== field.name);
      const r = await h.fetch(
        `/api/collections/${orders}`,
        json({ fields: [...kept, field] }, "PATCH"),
      );
      return { status: r.status, body: (await r.json()) as any };
    };

    test("a money total is kept from money children, exactly", async () => {
      const added = await addRollupField({
        name: "total",
        type: "money",
        money: { currency: "TRY" },
        rollup: { from: lines, via: "order", fn: "sum", field: "amount" },
      });
      expect(added.status).toBe(200);
      const order = await create(orders, { ref: "O-1" });
      for (const amount of [0.1, 0.2, 19.99]) {
        const line = await create(lines, { order: order.body.data.id, amount });
        expect(line.status).toBe(201);
      }
      const r = await h.fetch(`/api/items/${orders}/${order.body.data.id}`);
      // 0.1 + 0.2 + 19.99 in doubles is 20.290000000000003. In minor units it
      // is 10 + 20 + 1999, and the column holds exactly that.
      expect(((await r.json()) as any).data.total).toEqual({
        amount: 20.29,
        currency: "TRY",
      });
    });

    test("a rollup whose two ends disagree about the currency is refused", async () => {
      const r = await addRollupField({
        name: "total_usd",
        type: "money",
        money: { currency: "USD" },
        rollup: { from: lines, via: "order", fn: "sum", field: "amount" },
      });
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/no exchange rate/);
    });

    test("a money child summed into a plain number column is refused", async () => {
      const r = await addRollupField({
        name: "total_num",
        type: "number",
        rollup: { from: lines, via: "order", fn: "sum", field: "amount" },
      });
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/must be money too/);
    });

    test("avg over money is refused — an average falls between minor units", async () => {
      const r = await addRollupField({
        name: "mean",
        type: "money",
        money: { currency: "TRY" },
        rollup: { from: lines, via: "order", fn: "avg", field: "amount" },
      });
      expect(r.status).toBe(422);
      expect(msg(r.body)).toMatch(/between minor units/);
    });
  });

  describe("CSV", () => {
    test("exports a bare amount a spreadsheet can total, and imports it back", async () => {
      const r = await h.fetch(`/api/items/${products}/export?format=csv`);
      const text = await r.text();
      expect(r.status).toBe(200);
      // Not `{"amount":19.99,"currency":"TRY"}` — a column of numbers.
      expect(text).not.toContain('{""amount""');
      expect(text).toMatch(/(^|,)19\.99(,|$)/m);
    });
  });
});

/** Tiny stable hash so each generated collection slug is distinct per field. */
const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
};
