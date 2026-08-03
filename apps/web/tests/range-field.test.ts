/**
 * Date ranges — the interval semantics, the ordering rule, and the operators.
 *
 * The three claims under test are the three things that were broken:
 *
 *   1. **Back-to-back periods do not collide** (and under closed bounds, they
 *      do). That is one convention, applied once, instead of each caller
 *      deciding — and getting it wrong double-books a room.
 *   2. **A NULL endpoint is an OPEN one.** A contract with no end date has not
 *      ended, so it must come back from "what is in effect now". Written by hand
 *      as `end_date >= today` it silently does not.
 *   3. **A period cannot end before it begins**, without an admin hand-writing a
 *      cross-field rule per pair.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { matchesCondition } from "../../../packages/db/src/permission";
import {
  boundsOf,
  coversCondition,
  expandRangeOperators,
  overlapsCondition,
  parseRangeOperand,
  rangeFieldsOf,
  rangeOrderError,
  validateRangeSpec,
} from "../../../packages/db/src/range";
import { validateFields } from "../../../packages/db/src/field-types";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const D = (s: string) => Date.parse(s);
const SUBJECT = { userId: null, email: null, roles: [], tenantId: null } as never;

/** Evaluate an expanded `_overlaps` against a row with the JS predicate — the
 *  same interpreter realtime delivery and the permission simulator use. */
const rowOverlaps = (
  row: Record<string, unknown>,
  spec: { end: string; bounds?: "[)" | "[]" },
  operand: unknown,
): boolean =>
  matchesCondition(
    row,
    overlapsCondition("starts_at", spec, parseRangeOperand(operand)) as never,
    SUBJECT,
  );

describe("interval semantics", () => {
  const halfOpen = { end: "ends_at" as const };
  const closed = { end: "ends_at" as const, bounds: "[]" as const };

  test("back-to-back half-open periods do NOT collide", () => {
    // The bug this convention exists to make unwritable: a room booked
    // 09:00–10:00 and one booked 10:00–11:00 must both be allowed.
    const morning = { starts_at: D("2026-09-01T09:00Z"), ends_at: D("2026-09-01T10:00Z") };
    expect(
      rowOverlaps(morning, halfOpen, {
        start: D("2026-09-01T10:00Z"),
        end: D("2026-09-01T11:00Z"),
      }),
    ).toBe(false);
    // …while a genuine clash still is one.
    expect(
      rowOverlaps(morning, halfOpen, {
        start: D("2026-09-01T09:30Z"),
        end: D("2026-09-01T10:30Z"),
      }),
    ).toBe(true);
  });

  test("under closed bounds the shared endpoint DOES collide", () => {
    // Which is what a range of days means: leave "through Friday" includes
    // Friday, so another request starting Friday clashes.
    const week = { starts_at: D("2026-09-01"), ends_at: D("2026-09-04") };
    expect(rowOverlaps(week, closed, { start: D("2026-09-04"), end: D("2026-09-07") })).toBe(true);
    expect(rowOverlaps(week, halfOpen, { start: D("2026-09-04"), end: D("2026-09-07") })).toBe(false);
    expect(boundsOf(closed)).toBe("[]");
    expect(boundsOf(undefined)).toBe("[)");
  });

  test("a NULL end is an OPEN end — the row is still running", () => {
    // The sharp one. Hand-written as `ends_at >= X` this row is excluded, and
    // the query looks right while dropping exactly the rows that ARE active.
    const openContract = { starts_at: D("2020-01-01"), ends_at: null };
    expect(rowOverlaps(openContract, halfOpen, { start: D("2026-09-01"), end: D("2026-10-01") })).toBe(true);
  });

  test("a NULL start is open at the beginning", () => {
    const alwaysApplied = { starts_at: null, ends_at: D("2026-10-01") };
    expect(rowOverlaps(alwaysApplied, halfOpen, { start: D("2026-09-01"), end: D("2026-09-15") })).toBe(true);
    // …and it really does end.
    expect(rowOverlaps(alwaysApplied, halfOpen, { start: D("2026-11-01"), end: D("2026-12-01") })).toBe(false);
  });

  test("a one-sided query keeps its meaning", () => {
    const row = { starts_at: D("2026-09-01"), ends_at: D("2026-09-10") };
    // "anything not finished by 5 Sept"
    expect(rowOverlaps(row, halfOpen, { start: D("2026-09-05") })).toBe(true);
    expect(rowOverlaps(row, halfOpen, { start: D("2026-09-20") })).toBe(false);
    // "anything that had started by 5 Sept"
    expect(rowOverlaps(row, halfOpen, { end: D("2026-09-05") })).toBe(true);
    expect(rowOverlaps(row, halfOpen, { end: D("2026-08-01") })).toBe(false);
  });

  test("`_covers` asks whether a moment falls inside", () => {
    const row = { starts_at: D("2026-09-01T09:00Z"), ends_at: D("2026-09-01T10:00Z") };
    const covers = (t: string) =>
      matchesCondition(row, coversCondition("starts_at", halfOpen, D(t)) as never, SUBJECT);
    expect(covers("2026-09-01T09:00Z")).toBe(true); // start is inside
    expect(covers("2026-09-01T09:30Z")).toBe(true);
    expect(covers("2026-09-01T10:00Z")).toBe(false); // end is not
  });

  test("a period with neither side is refused rather than matching everything", () => {
    expect(() => parseRangeOperand({})).toThrow(/at least one/);
    expect(() => parseRangeOperand("soon")).toThrow();
    expect(() => parseRangeOperand([1, 2, 3])).toThrow(/pair/);
    // A [start, end] pair is accepted — it is what a date-range picker hands
    // over, and what `_between` already reads like.
    expect(parseRangeOperand([1, 2])).toEqual({ start: 1, end: 2 });
    expect(parseRangeOperand([null, 2])).toEqual({ start: undefined, end: 2 });
  });
});

describe("ordering", () => {
  const spec = { end: "ends_at" };

  test("an end before the start is refused, naming both columns", () => {
    const msg = rangeOrderError("starts_at", spec, {
      starts_at: D("2026-09-10"),
      ends_at: D("2026-09-01"),
    });
    expect(msg).toContain("ends_at");
    expect(msg).toContain("starts_at");
  });

  test("a zero-length half-open period is refused; a closed one is fine", () => {
    // Half-open, it contains no instant at all — it can never overlap anything
    // and can never be in effect, which is invisible after the fact.
    const t = D("2026-09-01T09:00Z");
    expect(rangeOrderError("starts_at", spec, { starts_at: t, ends_at: t })).toContain("zero length");
    // Closed, it is a single instant, which is a coherent thing to record.
    expect(
      rangeOrderError("starts_at", { end: "ends_at", bounds: "[]" }, { starts_at: t, ends_at: t }),
    ).toBeNull();
  });

  test("an open period has nothing to compare", () => {
    expect(rangeOrderError("starts_at", spec, { starts_at: D("2026-09-01"), ends_at: null })).toBeNull();
    expect(rangeOrderError("starts_at", spec, { starts_at: null, ends_at: null })).toBeNull();
  });

  test("the columns compare as instants whatever shape they arrived in", () => {
    // pg hands back ISO strings, SQLite epoch numbers, and a caller may send
    // either — so a mixed pair must still compare correctly.
    expect(
      rangeOrderError("starts_at", spec, {
        starts_at: "2026-09-10T00:00:00.000Z",
        ends_at: D("2026-09-01"),
      }),
    ).toContain("before");
    expect(
      rangeOrderError("starts_at", spec, {
        starts_at: new Date("2026-09-01"),
        ends_at: "2026-09-10T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("`ordered: false` opts out for a genuinely independent pair", () => {
    expect(
      rangeOrderError(
        "starts_at",
        { end: "ends_at", ordered: false },
        { starts_at: D("2026-09-10"), ends_at: D("2026-09-01") },
      ),
    ).toBeNull();
  });
});

describe("the spec, checked at save time", () => {
  const ts = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: "timestamp" as const,
    ...extra,
  });

  test("a valid pair is accepted", () => {
    expect(() =>
      validateFields([ts("starts_at", { range: { end: "ends_at" } }), ts("ends_at")]),
    ).not.toThrow();
  });

  test("an end column that does not exist, or is not a timestamp, fails here", () => {
    // The alternative symptom is an overlap filter comparing against a column
    // of something else and quietly answering wrong.
    expect(() => validateRangeSpec({ end: "nope" }, { fieldName: "starts_at", fieldTypes: {} })).toThrow(/unknown field/);
    expect(() =>
      validateRangeSpec({ end: "title" }, { fieldName: "starts_at", fieldTypes: { title: "text" } }),
    ).toThrow(/must be a timestamp/);
    expect(() =>
      validateRangeSpec({ end: "starts_at" }, { fieldName: "starts_at", fieldTypes: {} }),
    ).toThrow(/cannot be the start column itself/);
  });

  test("a range must start at a timestamp", () => {
    expect(() =>
      validateFields([
        { name: "label", type: "text", range: { end: "ends_at" } } as never,
        ts("ends_at"),
      ]),
    ).toThrow(/starts at a timestamp field/);
  });

  test("flags that would make the period unqueryable are refused", () => {
    for (const bad of [{ localized: true }, { unique: true }]) {
      expect(() =>
        validateFields([ts("starts_at", { range: { end: "ends_at" }, ...bad }), ts("ends_at")]),
      ).toThrow(/not allowed on a range field/);
    }
  });

  test("`indexed` is deliberately allowed — the overlap filter compares it", () => {
    expect(() =>
      validateFields([ts("starts_at", { range: { end: "ends_at" }, indexed: true }), ts("ends_at")]),
    ).not.toThrow();
  });
});

describe("the rewrite", () => {
  const fields = [
    { name: "starts_at", type: "timestamp", range: { end: "ends_at" } },
    { name: "ends_at", type: "timestamp" },
    { name: "title", type: "text" },
  ];
  const ranges = rangeFieldsOf(fields as never);

  test("a collection with no range is passed through untouched", () => {
    const cond = { title: { _eq: "x" } };
    expect(expandRangeOperators(cond, rangeFieldsOf([] as never))).toBe(cond);
  });

  test("only the range operators are rewritten; the rest still apply to the column", () => {
    // `starts_at: { _gte: X }` is a perfectly good question and is not a range
    // question — the start column stays an ordinary sortable timestamp.
    const out = expandRangeOperators({ starts_at: { _gte: 5 } }, ranges) as any;
    expect(out).toEqual({ starts_at: { _gte: 5 } });
  });

  test("a range operator and a plain one on the same field both survive", () => {
    const out = expandRangeOperators(
      { starts_at: { _gte: 5, _overlaps: { start: 1, end: 9 } } },
      ranges,
    ) as any;
    expect(JSON.stringify(out)).toContain('"_gte":5');
    expect(JSON.stringify(out)).toContain("ends_at");
  });

  test("it recurses through $and / $or / $not", () => {
    const out = expandRangeOperators(
      { $or: [{ starts_at: { _covers: 5 } }, { $not: { title: { _eq: "x" } } }] },
      ranges,
    ) as any;
    expect(JSON.stringify(out)).toContain("ends_at");
    expect(JSON.stringify(out)).toContain('"_eq":"x"');
  });

  test("a malformed operand names the field", () => {
    expect(() => expandRangeOperators({ starts_at: { _overlaps: {} } }, ranges)).toThrow(
      /starts_at.*_overlaps/,
    );
    expect(() => expandRangeOperators({ starts_at: { _covers: null } }, ranges)).toThrow(
      /needs a date/,
    );
  });
});

describe("end to end", () => {
  let h: TestHarness;
  const slug = "rg_leases";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "starts_at", type: "timestamp", range: { end: "ends_at" } },
          { name: "ends_at", type: "timestamp" },
        ],
      }),
    );
    for (const [title, s, e] of [
      ["sept", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"],
      ["oct", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"],
      ["openended", "2026-01-01T00:00:00Z", null],
    ] as [string, string, string | null][]) {
      await h.fetch(`/api/items/${slug}`, json({ title, starts_at: s, ends_at: e }));
    }
  });

  const namesFor = async (filter: unknown): Promise<string[]> => {
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify(filter))}`,
    );
    const body = (await r.json()) as any;
    if (!Array.isArray(body.data)) throw new Error(JSON.stringify(body));
    return body.data.map((x: any) => x.title).sort();
  };

  test("`_overlaps` finds the clash and not the neighbour", async () => {
    // September's lease ends exactly when October's begins, and half-open bounds
    // are what stop them colliding.
    expect(
      await namesFor({
        starts_at: { _overlaps: { start: "2026-09-15T00:00:00Z", end: "2026-09-20T00:00:00Z" } },
      }),
    ).toEqual(["openended", "sept"]);
  });

  test("the open-ended row comes back from a window years later", async () => {
    expect(
      await namesFor({
        starts_at: { _overlaps: { start: "2030-01-01T00:00:00Z", end: "2030-02-01T00:00:00Z" } },
      }),
    ).toEqual(["openended"]);
  });

  test("`_covers` answers what is in effect at an instant", async () => {
    expect(await namesFor({ starts_at: { _covers: "2026-10-15T00:00:00Z" } })).toEqual([
      "oct",
      "openended",
    ]);
  });

  test("a period that ends before it begins is a 422", async () => {
    const r = await h.fetch(
      `/api/items/${slug}`,
      json({ title: "backwards", starts_at: "2026-09-10T00:00:00Z", ends_at: "2026-09-01T00:00:00Z" }),
    );
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toContain("cannot end before it begins");
  });

  test("a PATCH that moves only the end is judged against the STORED start", async () => {
    // The case a patch-only check misses: the row already has a start, and the
    // patch carries just an end. Only the merged row can tell.
    const created = (await (
      await h.fetch(
        `/api/items/${slug}`,
        json({ title: "patchme", starts_at: "2026-09-10T00:00:00Z", ends_at: "2026-09-20T00:00:00Z" }),
      )
    ).json()) as any;
    const r = await h.fetch(
      `/api/items/${slug}/${created.data.id}`,
      json({ ends_at: "2026-09-01T00:00:00Z" }, "PATCH"),
    );
    expect(r.status).toBe(422);
  });

  test("an ISO-string operand compares correctly — the bug that predates ranges", async () => {
    // Before `normalizeTemporalOperands`, an ISO string reached SQLite as TEXT
    // and was compared against an INTEGER column. SQLite orders every number
    // before every string, so the comparison did not fail — it INVERTED. Against
    // the September lease (starts 2026-09-01):
    //
    //   _gte "2026-08-01"  → []      (wrong)
    //   _lte "2026-08-01"  → [rows]  (wrong)
    //
    // Confidently wrong in both directions, with nothing in the response to say
    // so, for the exact date format every read hands back. Correct on Postgres
    // throughout, which is why it survived.
    const after = await namesFor({ starts_at: { _gte: "2026-08-01T00:00:00Z" } });
    expect(after).toContain("sept");
    expect(after).toContain("oct");
    const before = await namesFor({ starts_at: { _lte: "2026-08-01T00:00:00Z" } });
    expect(before).not.toContain("sept");
    expect(before).not.toContain("oct");
    // Proven non-vacuous: the row that really IS before August comes back.
    expect(before).toContain("openended");
    // …and an epoch-number operand, which always worked, still does.
    expect(await namesFor({ starts_at: { _gte: Date.parse("2026-08-01T00:00:00Z") } })).toContain(
      "sept",
    );
  });

  test("the aggregate endpoint answers the same overlap question the list does", async () => {
    const r = await h.fetch(
      `/api/items/${slug}/aggregate`,
      json({
        agg: "count",
        filter: {
          starts_at: { _overlaps: { start: "2026-09-15T00:00:00Z", end: "2026-09-20T00:00:00Z" } },
        },
      }),
    );
    const body = (await r.json()) as any;
    // Compared against the LIST's answer for the same filter rather than a
    // hard-coded number: the two paths expand `_overlaps` independently, and
    // "they agree" is the actual claim. A literal would also make this test
    // depend on which sibling tests had already inserted rows.
    const listed = await namesFor({
      starts_at: { _overlaps: { start: "2026-09-15T00:00:00Z", end: "2026-09-20T00:00:00Z" } },
    });
    expect(Number(body.data?.[0]?.value)).toBe(listed.length);
    expect(listed.length).toBeGreaterThan(1);
  });
});
