/**
 * `uniqueWith` — the join-table rule `unique` cannot say.
 *
 * `unique` is per column. A join table's identity is a PAIR: one inventory
 * level per (variant, location), one listing per (product, channel), one
 * selected value per (variant, option). Neither column is unique on its own, so
 * nothing stopped a second row for the same pair — and the commerce model had
 * seven such tables. Measured before this existed: three inventory levels for
 * one (variant, location) made `sum(available)` answer 146 for a number that
 * should be one, and a variant held Size = S AND Size = M at once, which is
 * exactly the unresolvability `variant_option_values` was added to prevent.
 *
 * Declared on one participating field naming the others, so it rides in the
 * `fields` JSON the collection already stores — no migration, and the admin's
 * field editor is the natural place to expose it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { compositeUniqueSets, validateFields, type FieldDef } from "@backlex/db";

describe("uniqueWith: the declaration itself", () => {
  const base: FieldDef[] = [
    { name: "variant", type: "relation", to: "product_variants" },
    { name: "location", type: "relation", to: "locations" },
    { name: "qty", type: "integer" },
  ];
  const withUW = (uniqueWith: unknown, on = "location"): FieldDef[] =>
    base.map((f) => (f.name === on ? ({ ...f, uniqueWith } as FieldDef) : f));

  test("a well-formed pair validates", () => {
    expect(() => validateFields(withUW(["variant"]))).not.toThrow();
  });

  test("declaring it on BOTH ends is one constraint, not two", () => {
    // Otherwise the same rule said twice produces two indexes differing only in
    // column order — one of which the `IF NOT EXISTS` can never match again.
    const both = base.map((f) =>
      f.name === "location"
        ? ({ ...f, uniqueWith: ["variant"] } as FieldDef)
        : f.name === "variant"
          ? ({ ...f, uniqueWith: ["location"] } as FieldDef)
          : f,
    );
    expect(compositeUniqueSets(both)).toEqual([["location", "variant"]]);
  });

  test("the set is sorted, so declaration order cannot change the index", () => {
    expect(compositeUniqueSets(withUW(["variant"]))).toEqual([["location", "variant"]]);
  });

  test("an unknown sibling is refused by name", () => {
    expect(() => validateFields(withUW(["warehouse"]))).toThrow(/unknown field "warehouse"/);
  });

  test("naming itself is refused", () => {
    expect(() => validateFields(withUW(["location"]))).toThrow(/cannot name the field itself/);
  });

  test("an empty list is refused", () => {
    expect(() => validateFields(withUW([]))).toThrow(/non-empty array/);
  });

  test("it is refused beside `unique`, which already covers the column", () => {
    const f = base.map((x) =>
      x.name === "location" ? ({ ...x, unique: true, uniqueWith: ["variant"] } as FieldDef) : x,
    );
    expect(() => validateFields(f)).toThrow(/redundant beside "unique"/);
  });

  test("a field with no scalar column of its own is refused", () => {
    const many: FieldDef[] = [
      { name: "variant", type: "relation", to: "product_variants" },
      { name: "tags", type: "relation_many", to: "categories", uniqueWith: ["variant"] } as FieldDef,
    ];
    expect(() => validateFields(many)).toThrow(/relation_many/);
  });

  test("a partner with no scalar column is refused too", () => {
    const f: FieldDef[] = [
      { name: "notes", type: "text", localized: true },
      { name: "variant", type: "relation", to: "product_variants", uniqueWith: ["notes"] } as FieldDef,
    ];
    expect(() => validateFields(f)).toThrow(/localized/);
  });
});

describe("uniqueWith: the constraint the database keeps", () => {
  let h: TestHarness;

  const create = (body: unknown) =>
    h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const insert = (slug: string, body: unknown) =>
    h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await create({
      slug: "seat_map",
      fields: [
        { name: "row_label", type: "text" },
        { name: "seat_no", type: "integer", uniqueWith: ["row_label"] },
        { name: "holder", type: "text" },
      ],
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("the pair goes in once", async () => {
    expect((await insert("seat_map", { row_label: "A", seat_no: 1, holder: "Ada" })).status).toBe(201);
  });

  test("the same pair a second time is a 409, not a silent second row", async () => {
    const res = await insert("seat_map", { row_label: "A", seat_no: 1, holder: "Someone else" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  test("either column repeating on its own is fine — that is what `unique` could not express", async () => {
    expect((await insert("seat_map", { row_label: "A", seat_no: 2 })).status).toBe(201);
    expect((await insert("seat_map", { row_label: "B", seat_no: 1 })).status).toBe(201);
  });

  test("the API refuses a `uniqueWith` naming a field that is not there", async () => {
    const res = await create({
      slug: "bad_map",
      fields: [
        { name: "a", type: "text" },
        { name: "b", type: "text", uniqueWith: ["nope"] },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("adding the rule to a collection that already breaks it is refused, naming the columns", async () => {
    // The alternative — creating the index best-effort and logging — would
    // leave the schema claiming a guarantee the data does not keep.
    const made = await create({
      slug: "loose_pairs",
      fields: [
        { name: "left_side", type: "text" },
        { name: "right_side", type: "text" },
      ],
    });
    expect(made.status).toBe(201);
    for (let i = 0; i < 2; i++) {
      expect((await insert("loose_pairs", { left_side: "x", right_side: "y" })).status).toBe(201);
    }

    const patched = await h.fetch("/api/collections/loose_pairs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "left_side", type: "text" },
          { name: "right_side", type: "text", uniqueWith: ["left_side"] },
        ],
      }),
    });
    expect(patched.status).toBeGreaterThanOrEqual(400);
    const text = await patched.text();
    expect(text).toContain("left_side");
    expect(text).toContain("right_side");
  });
});
