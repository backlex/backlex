/**
 * Unit coverage for the shared realtime predicate (reactive invalidation
 * Stages 1 & 2). This is the single source of truth both transports use, so
 * the membership logic must be exhaustively pinned here.
 */
import { describe, expect, test } from "bun:test";
import type { AuthSubject } from "@backlex/core";
import {
  computeTransition,
  rowPasses,
} from "../src/server/services/realtime-filter";

const auth: AuthSubject = {
  userId: "u1",
  email: "u1@example.com",
  roles: ["authenticated"],
  tenantId: "t1",
};

describe("rowPasses (permission ∧ query filter)", () => {
  test("null conditions + no query filter → always passes", () => {
    expect(rowPasses({ id: 1 }, { authSubject: auth, conditions: null })).toBe(true);
  });

  test("empty conditions array → deny-all", () => {
    expect(rowPasses({ id: 1 }, { authSubject: auth, conditions: [] })).toBe(false);
  });

  test("permission condition gates the row", () => {
    const f = { authSubject: auth, conditions: [{ owner_id: { _eq: "$user.id" } }] };
    expect(rowPasses({ owner_id: "u1" }, f)).toBe(true);
    expect(rowPasses({ owner_id: "u2" }, f)).toBe(false);
  });

  test("query filter narrows on top of permission", () => {
    const f = {
      authSubject: auth,
      conditions: null,
      queryFilter: { done: { _eq: false } },
    };
    expect(rowPasses({ done: false }, f)).toBe(true);
    expect(rowPasses({ done: true }, f)).toBe(false);
  });

  test("query filter can only narrow — a row failing permission stays out even if the filter matches", () => {
    const f = {
      authSubject: auth,
      conditions: [{ owner_id: { _eq: "$user.id" } }],
      queryFilter: { done: { _eq: false } },
    };
    // matches the filter, but not owned by the caller → denied
    expect(rowPasses({ owner_id: "u2", done: false }, f)).toBe(false);
    // owned AND matches the filter → in
    expect(rowPasses({ owner_id: "u1", done: false }, f)).toBe(true);
  });
});

describe("computeTransition (Stage 2 membership)", () => {
  const f = { authSubject: auth, conditions: null, queryFilter: { done: { _eq: false } } };

  test("not-matching → matching is an enter", () => {
    expect(computeTransition({ done: true }, { done: false }, f)).toBe("enter");
  });
  test("matching → not-matching is a leave", () => {
    expect(computeTransition({ done: false }, { done: true }, f)).toBe("leave");
  });
  test("matching → matching is an update", () => {
    expect(computeTransition({ done: false }, { done: false }, f)).toBe("update");
  });
  test("not-matching → not-matching is none", () => {
    expect(computeTransition({ done: true }, { done: true }, f)).toBe("none");
  });
  test("absent before-row falls back to update-if-matching", () => {
    expect(computeTransition(undefined, { done: false }, f)).toBe("update");
    expect(computeTransition(undefined, { done: true }, f)).toBe("none");
  });
});
