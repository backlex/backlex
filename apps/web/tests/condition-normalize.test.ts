/**
 * Unit tests for `normalizeCondition` (@backlex/core) — the single front door
 * that maps accepted filter input shapes onto the canonical `Condition` the
 * compiler / predicate / permission store all speak. Pure function, no harness.
 */
import { describe, expect, test } from "bun:test";
import { normalizeCondition } from "@backlex/core";

describe("normalizeCondition — logical alias mapping", () => {
  test("_and → $and (recursively)", () => {
    expect(
      normalizeCondition({
        _and: [{ status: { _eq: "active" } }, { age: { _gte: 18 } }],
      }),
    ).toEqual({
      $and: [{ status: { _eq: "active" } }, { age: { _gte: 18 } }],
    });
  });

  test("_or → $or", () => {
    expect(normalizeCondition({ _or: [{ a: { _eq: 1 } }] })).toEqual({
      $or: [{ a: { _eq: 1 } }],
    });
  });

  test("_not → $not (single condition)", () => {
    expect(normalizeCondition({ _not: { a: { _eq: 1 } } })).toEqual({
      $not: { a: { _eq: 1 } },
    });
  });

  test("canonical $and passes through unchanged", () => {
    const c = { $and: [{ a: { _eq: 1 } }, { b: { _gt: 2 } }] };
    expect(normalizeCondition(c)).toEqual(c);
  });
});

describe("normalizeCondition — implicit equality", () => {
  test("scalar value → { _eq: value }", () => {
    expect(normalizeCondition({ status: "active" })).toEqual({
      status: { _eq: "active" },
    });
    expect(normalizeCondition({ age: 18, vip: true })).toEqual({
      age: { _eq: 18 },
      vip: { _eq: true },
    });
  });

  test("explicit operator object is left alone", () => {
    expect(normalizeCondition({ age: { _gte: 18 } })).toEqual({
      age: { _gte: 18 },
    });
  });
});

describe("normalizeCondition — nested-object relation form (schema-aware)", () => {
  const rels = new Set(["customer", "author"]);

  test("flattens one hop into a dotted key", () => {
    expect(
      normalizeCondition(
        { customer: { name: { _eq: "Alice" } } },
        { relationFields: rels },
      ),
    ).toEqual({ "customer.name": { _eq: "Alice" } });
  });

  test("flattens multi-hop into a dotted key", () => {
    expect(
      normalizeCondition(
        { customer: { address: { city: { _eq: "Berlin" } } } },
        { relationFields: rels },
      ),
    ).toEqual({ "customer.address.city": { _eq: "Berlin" } });
  });

  test("implicit-eq under a relation path", () => {
    expect(
      normalizeCondition(
        { customer: { tier: "gold" } },
        { relationFields: rels },
      ),
    ).toEqual({ "customer.tier": { _eq: "gold" } });
  });

  test("WITHOUT relationFields, a nested object is NOT flattened (json-safe)", () => {
    // Schema-blind path must not mistake a json column for a relation.
    const c = { customer: { name: { _eq: "Alice" } } };
    expect(normalizeCondition(c)).toEqual(c);
  });

  test("a non-relation key with a nested object is left untouched", () => {
    // `meta` is not in relationFields → treated as a literal (json) value.
    const c = { meta: { a: { _eq: 1 } } };
    expect(normalizeCondition(c, { relationFields: rels })).toEqual(c);
  });
});

describe("normalizeCondition — idempotency & passthrough", () => {
  test("normalize(normalize(x)) deep-equals normalize(x)", () => {
    const inputs: unknown[] = [
      { _and: [{ status: "active" }, { age: { _gte: 18 } }] },
      { customer: { name: { _eq: "Alice" } } },
      { $or: [{ a: { _eq: 1 } }, { b: 2 }] },
    ];
    const rels = new Set(["customer"]);
    for (const raw of inputs) {
      const once = normalizeCondition(raw, { relationFields: rels });
      const twice = normalizeCondition(once, { relationFields: rels });
      expect(twice).toEqual(once);
    }
  });

  test("non-object input returns unchanged", () => {
    expect(normalizeCondition(null as unknown)).toBeNull();
    expect(normalizeCondition("x" as unknown)).toBe("x");
  });

  test("dotted keys already in canonical form pass through", () => {
    const c = { "customer.name": { _eq: "Alice" } };
    expect(normalizeCondition(c, { relationFields: new Set(["customer"]) })).toEqual(c);
  });
});
