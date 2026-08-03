/**
 * Multi-surface parity for date ranges, and the template conversion.
 *
 * The claim is narrower than the other field features' and worth stating
 * precisely: `_overlaps` is not an operator anyone implements twice. It is
 * EXPANDED into comparisons the DSL already has, so what this gate really checks
 * is that every surface runs the expansion — because a surface that does not
 * sees an unrecognised operator on a timestamp column, and an unrecognised
 * operator compiles to TRUE. The failure mode is not an error. It is a filter
 * that silently matches every row in the collection.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { rangeOrderError } from "../../../packages/db/src/range";
import { parseQuery } from "../src/server/lib/query";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const slug = "par_range";
const WINDOW = { start: "2026-09-15T00:00:00Z", end: "2026-09-20T00:00:00Z" };

describe("date ranges — multi-surface parity", () => {
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
      ["hit", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"],
      ["miss", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
      ["open", "2026-01-01T00:00:00Z", null],
    ] as [string, string, string | null][]) {
      await h.fetch(`/api/items/${slug}`, json({ title, starts_at: s, ends_at: e }));
    }
  });

  test("REST expands the overlap", async () => {
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ starts_at: { _overlaps: WINDOW } }))}`,
    );
    const titles = ((await r.json()) as any).data.map((x: any) => x.title).sort();
    expect(titles).toEqual(["hit", "open"]);
  });

  test("the SDK agrees with REST", async () => {
    const res = (await sdk()
      .from<Record<string, unknown>>(slug)
      .list({ filter: { starts_at: { _overlaps: WINDOW } } as never })) as any;
    expect(res.data.map((x: any) => x.title).sort()).toEqual(["hit", "open"]);
  });

  test("GraphQL expands it too — and does not silently match everything", async () => {
    // The specific failure this gate exists for: an unrecognised operator
    // compiles to TRUE, so a surface that skipped the expansion would return
    // all three rows and look like it was working.
    const res = await gql(
      `query($f: JSON) { parRange(filter: $f) { title } }`,
      { f: { starts_at: { _overlaps: WINDOW } } },
    );
    expect(res.errors).toBeUndefined();
    const titles = (res.data?.parRange ?? []).map((x: any) => x.title).sort();
    expect(titles).toEqual(["hit", "open"]);
    expect(titles).not.toContain("miss");
  });

  test("GraphQL `_covers` agrees with REST's", async () => {
    const at = "2026-09-18T00:00:00Z";
    const g = await gql(`query($f: JSON) { parRange(filter: $f) { title } }`, {
      f: { starts_at: { _covers: at } },
    });
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ starts_at: { _covers: at } }))}`,
    );
    const rest = ((await r.json()) as any).data.map((x: any) => x.title).sort();
    expect((g.data?.parRange ?? []).map((x: any) => x.title).sort()).toEqual(rest);
    expect(rest).toEqual(["hit", "open"]);
  });

  test("a backwards period is refused on every write door", async () => {
    const bad = { title: "backwards", starts_at: "2026-09-10T00:00:00Z", ends_at: "2026-09-01T00:00:00Z" };
    const rest = await h.fetch(`/api/items/${slug}`, json(bad));
    expect(rest.status).toBe(422);
    // The batch endpoint runs through the same write path. It is non-atomic, so
    // a rejected operation is reported INSIDE a 200 rather than failing the
    // request — the claim is that the row was refused, not that the HTTP call
    // was.
    const batch = await h.fetch(
      `/api/items/${slug}/batch`,
      json({ operations: [{ op: "create", data: bad }] }),
    );
    const result = ((await batch.json()) as any).data;
    expect(result.failed).toBe(1);
    expect(result.results[0].error.code).toBe("VALIDATION");
    expect(result.results[0].error.message).toContain("cannot end before it begins");
  });

  test("a range operator is refused when the END column is not readable", () => {
    // Found in this branch's own security review. `_overlaps` on `starts_at`
    // expands into comparisons against `ends_at`, and that expansion runs AFTER
    // the filter has been checked against the caller's read allow-list — so
    // without this the end column was never checked at all, and a role granted
    // the start but not the end could bisect the end date by moving the window.
    // Holding read on one half of a period is not holding it on the other.
    //
    // Driven through `parseQuery` directly rather than over HTTP, because the
    // thing under test IS the field allow-list argument, and passing it here is
    // exactly what a restricted role's request does.
    const fields = [
      { name: "title", type: "text" },
      { name: "starts_at", type: "timestamp", range: { end: "ends_at" } },
      { name: "ends_at", type: "timestamp" },
    ] as never;
    const params = new URLSearchParams({
      filter: JSON.stringify({ starts_at: { _overlaps: WINDOW } }),
    });
    // Granted the start but not the end → refused.
    expect(() =>
      parseQuery(params, fields, false, new Set(["title", "starts_at"])),
    ).toThrow(/ends_at/);
    // Proven non-vacuous: granted BOTH, the identical filter parses fine, so the
    // throw above is the allow-list and not a malformed query.
    expect(() =>
      parseQuery(params, fields, false, new Set(["title", "starts_at", "ends_at"])),
    ).not.toThrow();
  });

  test("`_overlaps` on a field that declares no period is refused, not ignored", async () => {
    // Silently passing it through would compile an unrecognised operator, which
    // returns TRUE — a filter that matches every row and looks like it worked.
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ ends_at: { _overlaps: WINDOW } }))}`,
    );
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toContain("declares a period");
  });

  test("the shared rule is one function, not a copy per surface", () => {
    // Structural: what rots is a second implementation drifting from the first.
    // Every caller goes through `rangeOrderError`, so this is the whole rule.
    expect(rangeOrderError("a", { end: "b" }, { a: 2, b: 1 })).toBeTruthy();
    const src = readFileSync(
      resolve(import.meta.dir, "../src/server/services/items-helpers.ts"),
      "utf8",
    );
    expect(src).toContain("rangeOrderError");
  });
});

describe("the schema templates", () => {
  test("every start/end pair declares its period, with bounds that match the editor", async () => {
    // Twenty-eight pairs across fifteen templates. The bounds are DERIVED rather
    // than chosen per pair: a `datetime` field is a range of instants and must be
    // half-open (09:00–10:00 and 10:00–11:00 do not clash), while a `date` field
    // is a range of days and must be closed (leave "through Friday" includes
    // Friday). Getting that backwards is invisible until something double-books.
    const { TEMPLATES } = await import("../src/server/templates/catalog");
    const ENDOF: Record<string, string> = {
      starts_at: "ends_at",
      start_at: "end_at",
      start_date: "end_date",
      period_start: "period_end",
      current_period_start: "current_period_end",
      check_in: "check_out",
      started_at: "ended_at",
      sales_start: "sales_end",
      planned_start: "planned_end",
      starts_on: "ends_on",
    };
    const problems: string[] = [];
    let declared = 0;
    for (const tpl of TEMPLATES as any[]) {
      for (const col of tpl.collections ?? []) {
        const byName = new Map((col.fields ?? []).map((f: any) => [f.name, f]));
        for (const [start, end] of Object.entries(ENDOF)) {
          if (!byName.has(start) || !byName.has(end)) continue;
          const f = byName.get(start) as any;
          if (!f.range) {
            problems.push(`${tpl.id}.${col.slug}.${start} declares no range`);
            continue;
          }
          declared++;
          if (f.range.end !== end) {
            problems.push(`${tpl.id}.${col.slug}.${start} points at ${f.range.end}`);
          }
          const want = f.interface === "date" ? "[]" : undefined;
          if ((f.range.bounds ?? undefined) !== want) {
            problems.push(
              `${tpl.id}.${col.slug}.${start} is ${f.interface} but bounds=${f.range.bounds}`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
    // Proven non-vacuous: an empty corpus would pass the assertion above.
    expect(declared).toBe(28);
  });

  test("no sample row ships a period that ends before it begins", async () => {
    // Sample seeding inserts DIRECTLY into the physical table, so it never goes
    // through the write path's ordering check — a backwards sample would seed
    // every workspace with a row the API itself would refuse.
    const { TEMPLATES } = await import("../src/server/templates/catalog");
    const offenders: string[] = [];
    let checked = 0;
    for (const tpl of TEMPLATES as any[]) {
      for (const col of tpl.collections ?? []) {
        const ranged = (col.fields ?? []).filter((f: any) => f.range);
        if (ranged.length === 0) continue;
        for (const sample of col.samples ?? []) {
          for (const f of ranged) {
            if (sample[f.name] === undefined && sample[f.range.end] === undefined) continue;
            checked++;
            const problem = rangeOrderError(f.name, f.range, sample);
            if (problem) offenders.push(`${tpl.id}.${col.slug}: ${problem}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(checked).toBeGreaterThan(5);
  });
});
