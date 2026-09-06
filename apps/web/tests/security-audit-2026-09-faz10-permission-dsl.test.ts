/**
 * Phase 10 of the 2026-09 pre-prod audit — the permission compiler's two
 * fail-OPEN holes, plus the unbounded walk that turned a filter into a 500.
 *
 * Both holes were filed `medium`; both are the same sentence. *The compiler
 * every gated surface reads had two ways to answer TRUE without being asked a
 * question it could answer.*
 *
 *   1. **An operator nothing implements compiled to `(1=1)`.** Every operator
 *      is an independent `if`, and `looksLikeComparison` admits any key
 *      starting with `_`, so `{ owner_id: { _equals: "$user.id" } }` — one
 *      letter wrong — matched no branch, left `parts` empty and fell out of the
 *      bottom as "every row". Nothing validated a stored condition, so such a
 *      rule could sit in the `permissions` table indefinitely reading like a
 *      restriction and behaving like a grant. The in-memory evaluator, which
 *      decides what a realtime subscriber receives, did the same thing by the
 *      same route.
 *
 *   2. **`$not` over an unresolvable operand compiled to `NOT (1=0)`.** The
 *      compiler collapsed "this variable did not resolve" onto FALSE, which
 *      reads identically in a positive clause and inverts to TRUE under
 *      negation. `{$not: {owner_id: {_eq: "$user.id"}}}` for a subject with no
 *      user id — a public embed, an anonymous form, an unauthenticated read —
 *      returned EVERY row.
 *
 * The fix is one distinction the compiler was not making: SQL's own third
 * value. `UNKNOWN` (`(NULL = 1)`) behaves exactly like FALSE in a positive
 * clause and stays not-true under `NOT`, so nothing narrows anywhere except
 * where the old reading was wrong. The JS evaluator gained the same three
 * values, because it and the SQL compiler answer the same question for
 * different transports and a disagreement is a row delivered over a socket that
 * REST would have withheld.
 *
 * `_in: []` deliberately still compiles to FALSE: an explicitly empty list is a
 * REAL falsehood ("nothing is in nothing"), and `NOT` of it correctly matching
 * every row is the behaviour that separates it from an unresolved variable.
 * That pair is asserted here so the distinction cannot be flattened again.
 *
 * Guards verified by breaking them — see [[verify-a-guard-by-breaking-it]].
 */
import { describe, expect, test } from "bun:test";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  COMPARISON_OPERATORS,
  MAX_CONDITION_DEPTH,
  normalizeCondition,
  unknownOperators,
  type AuthSubject,
  type Condition,
} from "@backlex/core";
import { compileCondition, matchesCondition } from "@backlex/db";

const dialect = new SQLiteSyncDialect();

/** The rendered predicate, so an assertion can name the exact SQL rather than
 *  a drizzle object nobody can read in a diff. */
const toSql = (cond: Condition, ctx: AuthSubject): string =>
  dialect.sqlToQuery(
    compileCondition(cond, ctx, undefined, undefined, { dialect: "sqlite" }),
  ).sql;

const anon: AuthSubject = {
  userId: null,
  email: null,
  roles: [],
  tenantId: "t1",
} as AuthSubject;

const signedIn: AuthSubject = {
  userId: "u1",
  email: "u1@example.com",
  roles: ["editor"],
  tenantId: "t1",
} as AuthSubject;

// ---------------------------------------------------------------------------
// 1 — an operator nothing implements
// ---------------------------------------------------------------------------

describe("faz10: an unrecognised operator fails CLOSED, on both evaluators", () => {
  const typo = { owner_id: { _equals: "u1" } } as unknown as Condition;

  test("SQL: does not compile to a tautology", () => {
    const sql = toSql(typo, signedIn);
    // The defect, stated as the thing that must not come back.
    expect(sql).not.toContain("1=1");
    expect(sql).toContain("NULL = 1");
  });

  test("JS: a row that must not match, does not", () => {
    expect(matchesCondition({ owner_id: "SOMEONE-ELSE" }, typo, signedIn)).toBe(false);
  });

  test("JS: and neither does the row the author probably meant", () => {
    // Fail-closed means closed in both directions — a rule nobody can read is
    // not silently reinterpreted as the rule they might have meant.
    expect(matchesCondition({ owner_id: "u1" }, typo, signedIn)).toBe(false);
  });

  test("negating it does not open it either", () => {
    const negated = { $not: typo } as unknown as Condition;
    expect(matchesCondition({ owner_id: "u1" }, negated, signedIn)).toBe(false);
    expect(toSql(negated, signedIn)).not.toContain("1=0");
  });

  test("a genuinely empty comparison object is still 'no constraint'", () => {
    // `{}` says nothing, which is different from saying something unreadable.
    // Conflating the two would have made this change a silent denial.
    expect(matchesCondition({ owner_id: "x" }, { owner_id: {} }, signedIn)).toBe(true);
    expect(toSql({ owner_id: {} }, signedIn)).toContain("1=1");
  });

  test("every operator the type declares is still recognised", () => {
    // The guard is a SET, and a set that has drifted from the code it guards is
    // the exact failure mode this test exists to catch: an operator dropped
    // from `COMPARISON_OPERATORS` would start failing closed in production
    // while every other test stayed green.
    for (const op of ["_eq", "_neq", "_in", "_nin", "_gt", "_gte", "_lt", "_lte"]) {
      const cond = { f: { [op]: op === "_in" || op === "_nin" ? ["a"] : "a" } } as Condition;
      expect(toSql(cond, signedIn)).not.toContain("NULL = 1");
    }
  });
});

describe("faz10: unknownOperators names the bad key at the door", () => {
  test("reports a misspelling", () => {
    expect(unknownOperators({ owner_id: { _equals: "x" } })).toEqual(["_equals"]);
  });

  test("walks into $and / $or / $not and the underscore aliases", () => {
    expect(
      unknownOperators({ _and: [{ a: { _eq: 1 } }, { b: { _bogus: 2 } }] }),
    ).toEqual(["_bogus"]);
    expect(unknownOperators({ $not: { b: { _nope: 2 } } })).toEqual(["_nope"]);
  });

  test("accepts a well-formed condition", () => {
    expect(
      unknownOperators({
        $or: [{ a: { _eq: 1 } }, { b: { _icontains: "x" } }, { c: { _near: {} } }],
      }),
    ).toEqual([]);
  });

  test("accepts `_overlaps` / `_covers`, which are expanded before compiling", () => {
    // They never reach an evaluator — `expandRangeOperators` rewrites them — so
    // they are legal INPUT and would be a false positive here.
    expect(unknownOperators({ window: { _overlaps: [1, 2] } })).toEqual([]);
    expect(unknownOperators({ window: { _covers: 1 } })).toEqual([]);
  });

  test("does not mistake a json-column literal for a set of operators", () => {
    // `{ meta: { plan: "pro" } }` is a VALUE, not operators. Judging it would
    // reject a legitimate filter.
    expect(unknownOperators({ meta: { plan: "pro" } })).toEqual([]);
  });

  test("`_overlaps` is in the operator set but is not a compiler branch", () => {
    expect(COMPARISON_OPERATORS.has("_overlaps")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 — `$not` over an operand that did not resolve
// ---------------------------------------------------------------------------

describe("faz10: `$not` over an unresolvable operand stays closed", () => {
  // Every variable that can resolve to null, i.e. every one that an
  // unauthenticated subject carries nothing for.
  const nullable = ["$user.id", "$user.email", "$org.id", "$org.role"];

  for (const v of nullable) {
    test(`${v}: the positive clause denies (unchanged)`, () => {
      expect(matchesCondition({ f: "x" }, { f: { _eq: v } }, anon)).toBe(false);
    });

    test(`${v}: NEGATING it does not turn the denial into a grant`, () => {
      const cond = { $not: { f: { _eq: v } } } as Condition;
      expect(matchesCondition({ f: "x" }, cond, anon)).toBe(false);
      // `NOT (1=0)` is the defect written out; it must not be what we emit.
      expect(toSql(cond, anon)).not.toContain("1=0");
    });
  }

  test("`_neq` against an unresolved variable no longer means 'every owned row'", () => {
    // It used to compile to `owner_id IS NOT NULL` — the answer to "rows not
    // owned by me", asked by nobody.
    const cond = { owner_id: { _neq: "$user.id" } } as Condition;
    expect(toSql(cond, anon)).not.toContain("IS NOT NULL");
    expect(matchesCondition({ owner_id: "someone" }, cond, anon)).toBe(false);
  });

  test("a LIKE needle that did not resolve is not the string \"null\"", () => {
    // The old code did `String(r(v))`, so this searched for rows containing
    // "null" — and matched every row that did not, under `$not`.
    //
    // Asserted on BOTH engines and across the whole LIKE family. The SQL half
    // has its own `needle` and the JS half has another; a first pass tested
    // only the second, and breaking the first stayed green.
    for (const op of [
      "_contains",
      "_starts_with",
      "_ends_with",
      "_icontains",
      "_istarts_with",
      "_iends_with",
    ]) {
      const cond = { name: { [op]: "$user.email" } } as Condition;
      expect(matchesCondition({ name: "a null value" }, cond, anon)).toBe(false);
      expect(matchesCondition({ name: "a null value" }, { $not: cond } as Condition, anon)).toBe(
        false,
      );
      const sql = toSql(cond, anon);
      expect(sql).toContain("NULL = 1");
      expect(sql).not.toContain("LIKE");
    }
  });

  test("`_in` / `_nin` over an operand that is not a list at all", () => {
    // `resolveList` used to answer `[]` for BOTH "the author wrote []" and
    // "the variable did not resolve", which made `_nin` match every row
    // outright — a fail-open with no `$not` in sight.
    const inCond = { f: { _in: "$user.id" } } as unknown as Condition;
    const ninCond = { f: { _nin: "$user.id" } } as unknown as Condition;
    expect(matchesCondition({ f: "x" }, inCond, anon)).toBe(false);
    expect(matchesCondition({ f: "x" }, { $not: inCond } as Condition, anon)).toBe(false);
    expect(matchesCondition({ f: "x" }, ninCond, anon)).toBe(false);
    expect(toSql(inCond, anon)).toContain("NULL = 1");
    expect(toSql(ninCond, anon)).toContain("NULL = 1");
  });

  test("an explicitly EMPTY `_in` is a real falsehood, and `$not` of it still opens", () => {
    // The distinction the fix turns on. Flattening these two back together in
    // either direction breaks one of the two assertions below.
    const empty = { owner_id: { _in: [] } } as Condition;
    expect(matchesCondition({ owner_id: "x" }, empty, signedIn)).toBe(false);
    expect(matchesCondition({ owner_id: "x" }, { $not: empty } as Condition, signedIn)).toBe(
      true,
    );
    expect(toSql({ $not: empty } as Condition, signedIn)).toContain("1=0");
  });

  test("a signed-in subject is unaffected — the rule still means what it says", () => {
    const cond = { owner_id: { _eq: "$user.id" } } as Condition;
    expect(matchesCondition({ owner_id: "u1" }, cond, signedIn)).toBe(true);
    expect(matchesCondition({ owner_id: "u2" }, cond, signedIn)).toBe(false);
    expect(matchesCondition({ owner_id: "u2" }, { $not: cond } as Condition, signedIn)).toBe(
      true,
    );
  });
});

describe("faz10: three-valued logic composes the way SQL does", () => {
  const unresolvable = { f: { _eq: "$user.id" } } as Condition;

  test("AND: an UNKNOWN limb cannot be argued away by a TRUE one", () => {
    const cond = { $and: [unresolvable, { g: { _eq: 1 } }] } as Condition;
    expect(matchesCondition({ f: "x", g: 1 }, cond, anon)).toBe(false);
  });

  test("OR: a TRUE limb still grants beside an UNKNOWN one", () => {
    // This is why UNKNOWN is not simply "deny": a second role's unconditional
    // grant must survive the first role's unresolvable condition.
    const cond = { $or: [unresolvable, { g: { _eq: 1 } }] } as Condition;
    expect(matchesCondition({ f: "x", g: 1 }, cond, anon)).toBe(true);
  });

  test("OR: two UNKNOWN limbs deny", () => {
    const cond = { $or: [unresolvable, { h: { _eq: "$org.id" } }] } as Condition;
    expect(matchesCondition({ f: "x", h: "y" }, cond, anon)).toBe(false);
  });

  test("SQL and JS agree on every case above", () => {
    // The two evaluators back different transports (REST vs realtime). The
    // rendered SQL is asserted for shape; the point here is that neither engine
    // says TRUE where the other says FALSE.
    for (const cond of [
      unresolvable,
      { $not: unresolvable } as Condition,
      { $and: [unresolvable, { g: { _eq: 1 } }] } as Condition,
    ]) {
      expect(matchesCondition({ f: "x", g: 1 }, cond, anon)).toBe(false);
      expect(toSql(cond, anon)).toContain("NULL = 1");
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — the unbounded walk (filed separately as the aggregate 500)
// ---------------------------------------------------------------------------

describe("faz10: condition nesting is bounded at the front door", () => {
  /** Wire bytes built WITHOUT recursing, the way a caller sends them. */
  const wire = (depth: number) =>
    '{"$not":'.repeat(depth) + '{"title":{"_eq":"x"}}' + "}".repeat(depth);

  test("`JSON.parse` accepts 450 KB of nesting — the parser is not the guard", () => {
    // Recorded because it is the premise of the finding: nothing upstream stops
    // this, so the walk itself had to.
    const body = wire(50_000);
    expect(body.length).toBeGreaterThan(450_000);
    expect(() => JSON.parse(body)).not.toThrow();
  });

  test("normalizeCondition refuses over-deep input instead of overflowing", () => {
    // It used to be a `RangeError: Maximum call stack size exceeded` at ~20k
    // levels, which the error handler renders as a 500.
    let err: unknown;
    try {
      normalizeCondition(JSON.parse(wire(50_000)));
    } catch (e) {
      err = e;
    }
    expect((err as Error | undefined)?.name).not.toBe("RangeError");
    expect((err as { code?: string } | undefined)?.code).toBe("VALIDATION");
    expect((err as Error).message).toContain(String(MAX_CONDITION_DEPTH));
  });

  test("a filter at the limit still works", () => {
    // A cap that refuses legitimate input is a different bug.
    expect(() => normalizeCondition(JSON.parse(wire(MAX_CONDITION_DEPTH - 1)))).not.toThrow();
  });

  test("breadth is not depth — a wide `$or` costs one level", () => {
    const wide = { $or: Array.from({ length: 500 }, (_, i) => ({ f: { _eq: i } })) };
    expect(() => normalizeCondition(wide)).not.toThrow();
  });

  test("nested-object relation form is bounded too", () => {
    // The OTHER recursion: `{a:{a:{a:…}}}` reaches `flattenNested` without a
    // single `$not`.
    let node: unknown = { _eq: "x" };
    for (let i = 0; i < 200; i++) node = { rel: node };
    expect(() =>
      normalizeCondition(node, { relationFields: new Set(["rel"]) }),
    ).toThrow();
  });
});
