/**
 * The DSL → row-level-security compiler, in isolation.
 *
 * Two things here are worth more than the rest. `pgLiteral` is the ONLY place
 * a value is spliced into DDL — `CREATE POLICY` takes no parameters — so it is
 * tested against the shapes an attacker would reach for, and against the ones
 * it must refuse rather than guess at. And a condition the compiler cannot
 * carry has to be REPORTED, never quietly downgraded to "no condition", which
 * would install a policy strictly wider than the rule it came from.
 */
import { describe, expect, test } from "bun:test";
import {
  compileConditionToPolicy,
  pgIdent,
  pgLiteral,
  policyName,
  policyStatements,
  rlsBlockers,
  rlsUnmappedVariables,
} from "@backlex/db";
import type { Condition } from "@backlex/core";

describe("pgLiteral", () => {
  test("doubles a quote rather than escaping it with a backslash", () => {
    // Complete under `standard_conforming_strings`, which the apply path
    // verifies rather than assuming.
    expect(pgLiteral("O'Brien")).toBe("'O''Brien'");
  });

  test("a closing-quote injection cannot escape the literal", () => {
    expect(pgLiteral("'; DROP TABLE users; --")).toBe("'''; DROP TABLE users; --'");
  });

  test("a backslash stays an ordinary character", () => {
    // The reason the doubling is sufficient: with standard_conforming_strings
    // on, `\` is not an escape, so `\'` does NOT smuggle a quote through.
    expect(pgLiteral("a\\'b")).toBe("'a\\''b'");
  });

  test("numbers, booleans, null and dates each have one spelling", () => {
    expect(pgLiteral(42)).toBe("42");
    expect(pgLiteral(-1.5)).toBe("-1.5");
    expect(pgLiteral(true)).toBe("TRUE");
    expect(pgLiteral(null)).toBe("NULL");
    expect(pgLiteral(undefined)).toBe("NULL");
    expect(pgLiteral(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "'2026-01-02T03:04:05.000Z'::timestamptz",
    );
  });

  test("anything else THROWS instead of being guessed at", () => {
    // A compiler that guessed here could emit a policy meaning something other
    // than the rule it came from — which is worse than refusing to compile.
    expect(() => pgLiteral({ a: 1 })).toThrow();
    expect(() => pgLiteral([1, 2])).toThrow();
    expect(() => pgLiteral(Number.NaN)).toThrow();
    expect(() => pgLiteral(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => pgLiteral("nul\u0000byte")).toThrow();
  });
});

describe("identifiers and policy names", () => {
  test("an identifier's own quotes are doubled", () => {
    expect(pgIdent('we"ird')).toBe('"we""ird"');
  });

  test("a long name is truncated AND disambiguated, never just truncated", () => {
    const a = policyName("a".repeat(40), "b".repeat(40), "read");
    const b = policyName("a".repeat(40), "b".repeat(41), "read");
    expect(a.length).toBeLessThanOrEqual(63);
    expect(b.length).toBeLessThanOrEqual(63);
    // Truncation alone would collide these two into one policy — one rule
    // would silently replace another.
    expect(a).not.toBe(b);
  });

  test("a short name is left readable", () => {
    expect(policyName("posts", "editor", "read")).toBe("backlex_posts_editor_read");
  });
});

describe("variables stay symbolic", () => {
  test("$user.id becomes a function call, not this request's value", () => {
    // The whole feature: a policy is compiled once and evaluated by Postgres
    // for whoever is connected.
    const sql = compileConditionToPolicy({ owner_id: { _eq: "$user.id" } } as Condition);
    expect(sql).toContain("backlex.uid()");
    expect(sql).toContain('"owner_id"');
  });

  test("$user.roles in an _in becomes = ANY(...), not an empty IN list", () => {
    // `resolveList` yields `[]` for a non-array, which the callers read as
    // "matches nothing" — so without the array branch this policy would deny
    // every row while looking correct.
    const sql = compileConditionToPolicy({ team: { _in: "$user.orgs" } } as unknown as Condition);
    expect(sql).toContain("= ANY(backlex.orgs())");
    expect(sql).not.toContain("FALSE");
  });

  test("a _nin against a variable array negates the same expression", () => {
    const sql = compileConditionToPolicy({ team: { _nin: "$user.orgs" } } as unknown as Condition);
    expect(sql).toContain("NOT (");
    expect(sql).toContain("= ANY(backlex.orgs())");
  });

  test("literals in the rule are inlined as literals", () => {
    const sql = compileConditionToPolicy({ status: { _eq: "published" } } as Condition);
    expect(sql).toContain("'published'");
    // No bound parameters survive: CREATE POLICY cannot take one.
    expect(sql).not.toMatch(/\$\d/);
  });

  test("a quote inside a stored rule cannot break out of the policy", () => {
    const sql = compileConditionToPolicy({ status: { _eq: "') OR true --" } } as Condition);
    expect(sql).toContain("''') OR true --'");
  });

  test("a `$` inside a COLUMN NAME is not mistaken for a placeholder", () => {
    // An adopted table can carry any column name, and the condition key is
    // whatever the operator wrote. A blind regex over the rendered SQL would
    // rewrite the inside of `"a$1"` with the first bound literal — which is
    // both wrong and caller-influenced. Found in this branch's own security
    // review; fails without the identifier-aware scan.
    const sql = compileConditionToPolicy({ a$1: { _eq: "kept" } } as unknown as Condition);
    expect(sql).toContain('"a$1"');
    expect(sql).toContain("'kept'");
  });

  test("$and / $or / $not compose the same way they do in a WHERE", () => {
    const sql = compileConditionToPolicy({
      $or: [{ owner_id: { _eq: "$user.id" } }, { $not: { status: { _eq: "draft" } } }],
    } as Condition);
    expect(sql).toContain(" OR ");
    expect(sql).toContain("NOT (");
  });
});

describe("what the compiler refuses", () => {
  test("a condition that walks a relation is a blocker", () => {
    const blockers = rlsBlockers({ "author_id.name": { _eq: "x" } } as Condition);
    expect(blockers.length).toBe(1);
    expect(blockers[0]).toContain("relation");
  });

  test("`_near` is a blocker — a policy has no query origin", () => {
    const blockers = rlsBlockers({
      location: { _near: { lat: 1, lng: 2, km: 5 } },
    } as unknown as Condition);
    expect(blockers[0]).toContain("origin");
  });

  test("a blocker nested inside $and is still found", () => {
    const blockers = rlsBlockers({
      $and: [{ status: { _eq: "x" } }, { $not: { "a.b": { _eq: 1 } } }],
    } as Condition);
    expect(blockers.length).toBe(1);
  });

  test("a variable with no SQL expression is reported, not silently denied", () => {
    // Without this report the policy would compile to a comparison against
    // null — i.e. deny every row — and look perfectly healthy.
    expect(rlsUnmappedVariables({ x: { _eq: "$user.made_up" } } as Condition)).toEqual([
      "$user.made_up",
    ]);
    expect(rlsUnmappedVariables({ x: { _eq: "$user.id" } } as Condition)).toEqual([]);
  });
});

describe("policy statements", () => {
  const base = {
    collection: "posts",
    table: "c_abc_posts",
    role: "editor",
    action: "read" as const,
    condition: null,
    tenantScoped: true,
    softDelete: true,
    appliesTo: "PUBLIC",
  };

  test("a read policy is USING only, and carries the role, tenant and soft-delete", () => {
    const [drop, create] = policyStatements(base);
    // Dropped first: CREATE POLICY has no OR REPLACE, and IF NOT EXISTS would
    // leave the OLD rule live after an edit.
    expect(drop).toContain("DROP POLICY IF EXISTS");
    expect(create).toContain("FOR SELECT");
    expect(create).toContain("TO PUBLIC");
    expect(create).toContain("backlex.has_role('editor')");
    expect(create).toContain('"tenant_id" = backlex.tenant_id()');
    expect(create).toContain('"deleted_at" IS NULL');
    expect(create).not.toContain("WITH CHECK");
  });

  test("an insert policy is WITH CHECK only — there is no existing row to see", () => {
    const [, create] = policyStatements({ ...base, action: "create" });
    expect(create).toContain("FOR INSERT");
    expect(create).toContain("WITH CHECK");
    expect(create).not.toContain("USING");
    // A new row has no prior state to have been deleted.
    expect(create).not.toContain("deleted_at");
  });

  test("an update policy has BOTH, or a row could be moved out of scope", () => {
    const [, create] = policyStatements({ ...base, action: "update" });
    expect(create).toContain("USING (");
    expect(create).toContain("WITH CHECK (");
  });

  test("a named role is quoted; PUBLIC is a keyword", () => {
    const [, named] = policyStatements({ ...base, appliesTo: "reporting" });
    expect(named).toContain('TO "reporting"');
  });

  test("an untenanted collection gets no tenant clause", () => {
    const [, create] = policyStatements({ ...base, tenantScoped: false, softDelete: false });
    expect(create).not.toContain("tenant_id");
    expect(create).not.toContain("deleted_at");
  });
});
