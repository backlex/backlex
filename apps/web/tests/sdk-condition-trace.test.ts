/**
 * SDK-vendored condition + trace modules (packages/client/src/{condition,trace}.ts).
 *
 * `condition.ts` is a deliberate vendored copy of @backlex/core's
 * `normalizeCondition` (see its header comment) so the published `backlex`
 * package has zero workspace deps. These tests mirror the canonical cases in
 * tests/condition-normalize.test.ts AND cross-check the two implementations
 * byte-for-byte on shared inputs — if the copies ever drift, this fails.
 *
 * `trace.ts` builds W3C `traceparent` values
 * (`00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`). Pure functions, no
 * harness.
 */
import { describe, expect, test } from "bun:test";
import { normalizeCondition as normalizeCore, type Condition } from "@backlex/core";
import { normalizeCondition } from "../../../packages/client/src/condition";
import {
  makeTraceparent,
  newSpanId,
  newTraceId,
} from "../../../packages/client/src/trace";

// ── condition.ts — canonical normalization cases ────────────────────────────

describe("client normalizeCondition — logical alias mapping", () => {
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
    const c: Condition = { $and: [{ a: { _eq: 1 } }, { b: { _gt: 2 } }] };
    expect(normalizeCondition(c)).toEqual(c);
  });
});

describe("client normalizeCondition — implicit equality", () => {
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

describe("client normalizeCondition — nested-object relation form", () => {
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
      normalizeCondition({ customer: { tier: "gold" } }, { relationFields: rels }),
    ).toEqual({ "customer.tier": { _eq: "gold" } });
  });

  test("WITHOUT relationFields, a nested object is NOT flattened (json-safe)", () => {
    const c = { customer: { name: { _eq: "Alice" } } } as unknown as Condition;
    expect(normalizeCondition(c)).toEqual(c);
  });

  test("a non-relation key with a nested object is left untouched", () => {
    const c = { meta: { a: { _eq: 1 } } } as unknown as Condition;
    expect(normalizeCondition(c, { relationFields: rels })).toEqual(c);
  });
});

describe("client normalizeCondition — idempotency & passthrough", () => {
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
    expect(normalizeCondition("x" as unknown)).toBe("x" as unknown as Condition);
  });

  test("dotted keys already in canonical form pass through", () => {
    const c = { "customer.name": { _eq: "Alice" } };
    expect(
      normalizeCondition(c, { relationFields: new Set(["customer"]) }),
    ).toEqual(c);
  });
});

describe("client normalizeCondition ↔ @backlex/core parity", () => {
  // The vendored copy must be behaviorally identical to the canonical one —
  // the query builder compiles to this JSON and the REST API parses it with
  // the core implementation.
  const rels = new Set(["customer", "author"]);
  const inputs: unknown[] = [
    { status: "active" },
    { age: { _gte: 18 }, vip: true },
    { _and: [{ status: "active" }, { _or: [{ a: 1 }, { b: { _lt: 5 } }] }] },
    { _not: { deleted: { _null: false } } },
    { customer: { name: { _eq: "Alice" } } },
    { customer: { address: { city: "Berlin" } } },
    { meta: { a: { _eq: 1 } } },
    { author: { tier: "gold" }, title: { _icontains: "hello" } },
    { "customer.name": { _eq: "Alice" } },
    null,
    "raw-string",
    42,
  ];

  test("identical output with relationFields", () => {
    for (const raw of inputs) {
      expect(normalizeCondition(raw, { relationFields: rels })).toEqual(
        normalizeCore(raw, { relationFields: rels }) as ReturnType<
          typeof normalizeCondition
        >,
      );
    }
  });

  test("identical output without relationFields (schema-blind)", () => {
    for (const raw of inputs) {
      expect(normalizeCondition(raw)).toEqual(
        normalizeCore(raw) as ReturnType<typeof normalizeCondition>,
      );
    }
  });
});

// ── trace.ts — W3C traceparent generation ───────────────────────────────────

describe("trace — id generators", () => {
  test("newTraceId is 32 lowercase hex chars", () => {
    const id = newTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("newSpanId is 16 lowercase hex chars", () => {
    const id = newSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("ids are unique across calls", () => {
    const traces = new Set(Array.from({ length: 50 }, () => newTraceId()));
    const spans = new Set(Array.from({ length: 50 }, () => newSpanId()));
    expect(traces.size).toBe(50);
    expect(spans.size).toBe(50);
  });
});

describe("trace — makeTraceparent", () => {
  test("default: fresh sampled trace in 00-<32hex>-<16hex>-01 form", () => {
    expect(makeTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  test("sampled=false flips the flags byte to 00", () => {
    expect(makeTraceparent(undefined, false)).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/,
    );
  });

  test("continuing a trace reuses the trace id but mints a fresh span id", () => {
    const traceId = newTraceId();
    const a = makeTraceparent(traceId);
    const b = makeTraceparent(traceId);
    const [, aTrace, aSpan] = a.split("-");
    const [, bTrace, bSpan] = b.split("-");
    expect(aTrace).toBe(traceId);
    expect(bTrace).toBe(traceId);
    expect(aSpan).toMatch(/^[0-9a-f]{16}$/);
    expect(aSpan).not.toBe(bSpan);
  });

  test("fresh calls never share a trace or span id", () => {
    const parts = Array.from({ length: 50 }, () => makeTraceparent().split("-"));
    const traceIds = new Set(parts.map((p) => p[1]));
    const spanIds = new Set(parts.map((p) => p[2]));
    expect(traceIds.size).toBe(50);
    expect(spanIds.size).toBe(50);
  });
});
