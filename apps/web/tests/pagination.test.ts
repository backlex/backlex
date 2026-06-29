/**
 * Unit coverage for the shared `parsePagination` helper. The key guarantee is
 * the HARD ceiling: list routes (uploads/webhooks) used to accept an unbounded
 * `?limit`, a row-count DoS edge. Garbage input must fall back to defaults.
 */
import { describe, expect, test } from "bun:test";
import { parsePagination } from "../src/server/lib/pagination";

const ctx = (q: Record<string, string>) => ({
  req: { query: (k: string) => q[k] },
});

describe("parsePagination", () => {
  test("defaults when no query params", () => {
    expect(parsePagination(ctx({}))).toEqual({ limit: 50, offset: 0 });
  });

  test("clamps limit to the hard max (DoS guard)", () => {
    expect(parsePagination(ctx({ limit: "100000" })).limit).toBe(200);
    expect(parsePagination(ctx({ limit: "100000" }), { maxLimit: 500 }).limit).toBe(500);
  });

  test("floors limit at 1 and offset at 0", () => {
    expect(parsePagination(ctx({ limit: "0" })).limit).toBe(1);
    expect(parsePagination(ctx({ limit: "-5" })).limit).toBe(1);
    expect(parsePagination(ctx({ offset: "-9" })).offset).toBe(0);
  });

  test("honors custom defaults", () => {
    expect(parsePagination(ctx({}), { defaultLimit: 100 }).limit).toBe(100);
    expect(parsePagination(ctx({}), { defaultOffset: 20 }).offset).toBe(20);
  });

  test("garbage / non-finite input falls back to defaults, not NaN", () => {
    const p = parsePagination(ctx({ limit: "abc", offset: "xyz" }), {
      defaultLimit: 25,
    });
    expect(p.limit).toBe(25);
    expect(p.offset).toBe(0);
    expect(Number.isNaN(p.limit)).toBe(false);
  });

  test("passes through a valid in-range request (floored)", () => {
    expect(parsePagination(ctx({ limit: "30.7", offset: "10" }))).toEqual({
      limit: 30,
      offset: 10,
    });
  });
});
