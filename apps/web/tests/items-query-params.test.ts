/**
 * Unit tests for the admin item-list pure helpers
 * (`apps/web/src/client/admin/items-query-params.ts`).
 *
 * These back the React Query migration of the admin item list: `buildItemsParams`
 * turns the filter UI state into the server query (the logic lifted out of the
 * old hand-rolled list effect), and `reconcileBulkUpdate` is the partial-success
 * reconcile a bulk-update mutation runs after rolling the optimistic patch back.
 * Both are framework-free, so they're tested directly — there is no React render
 * harness in this repo.
 */
import { describe, expect, test } from "bun:test";
import {
  buildItemsParams,
  reconcileBulkUpdate,
} from "../src/client/admin/items-query-params";
import type { Post } from "../src/client/admin/config";

describe("buildItemsParams", () => {
  test("defaults: no search, no filters, no status → just limit + sort", () => {
    const p = buildItemsParams({
      sort: "-updated_at",
      q: "",
      filters: [],
      statusTab: "all",
      statusFieldName: "status",
    });
    expect(p).toEqual({ limit: 50, sort: "-updated_at" });
    expect(p.q).toBeUndefined();
    expect(p.filter).toBeUndefined();
  });

  test("empty sort is omitted — the server applies defaultSort/-created_at", () => {
    expect(
      buildItemsParams({ sort: "", q: "", filters: [], statusTab: "all", statusFieldName: null }).sort,
    ).toBeUndefined();
  });

  test("trims the search term and only sets q when non-empty", () => {
    expect(buildItemsParams({ sort: "x", q: "  hello  ", filters: [], statusTab: "all", statusFieldName: null }).q).toBe(
      "hello",
    );
    expect(buildItemsParams({ sort: "x", q: "   ", filters: [], statusTab: "all", statusFieldName: null }).q).toBeUndefined();
  });

  test("single chip → bare clause (no $and wrapper)", () => {
    const p = buildItemsParams({
      sort: "x",
      q: "",
      filters: [{ field: "title", op: "_contains", value: "hi" }],
      statusTab: "all",
      statusFieldName: null,
    });
    expect(JSON.parse(p.filter as string)).toEqual({ title: { _contains: "hi" } });
  });

  test("multiple chips → $and array preserving duplicate field+op pairs", () => {
    const p = buildItemsParams({
      sort: "x",
      q: "",
      filters: [
        { field: "views", op: "_gt", value: 1 },
        { field: "views", op: "_gt", value: 5 },
      ],
      statusTab: "all",
      statusFieldName: null,
    });
    expect(JSON.parse(p.filter as string)).toEqual({
      $and: [{ views: { _gt: 1 } }, { views: { _gt: 5 } }],
    });
  });

  test("active status tab appends an _eq clause on the resolved field name", () => {
    const p = buildItemsParams({
      sort: "x",
      q: "",
      filters: [],
      statusTab: "published",
      statusFieldName: "stage",
    });
    expect(JSON.parse(p.filter as string)).toEqual({ stage: { _eq: "published" } });
  });

  test("status tab is ignored when no status field is resolved", () => {
    const p = buildItemsParams({
      sort: "x",
      q: "",
      filters: [],
      statusTab: "published",
      statusFieldName: null,
    });
    expect(p.filter).toBeUndefined();
  });

  test("chip + status combine under $and", () => {
    const p = buildItemsParams({
      sort: "x",
      q: "",
      filters: [{ field: "title", op: "_contains", value: "hi" }],
      statusTab: "draft",
      statusFieldName: "status",
    });
    expect(JSON.parse(p.filter as string)).toEqual({
      $and: [{ title: { _contains: "hi" } }, { status: { _eq: "draft" } }],
    });
  });
});

describe("reconcileBulkUpdate", () => {
  const rows = [
    { id: "a", status: "draft", updated_at: "t0" },
    { id: "b", status: "draft", updated_at: "t0" },
    { id: "c", status: "draft", updated_at: "t0" },
  ] as unknown as Post[];

  test("applies the patch + new timestamp to confirmed ids only", () => {
    const out = reconcileBulkUpdate(rows, new Set(["a", "c"]), { status: "published" }, "t1");
    expect(out).toEqual([
      { id: "a", status: "published", updated_at: "t1" },
      { id: "b", status: "draft", updated_at: "t0" },
      { id: "c", status: "published", updated_at: "t1" },
    ] as unknown as Post[]);
  });

  test("empty ok set leaves every row untouched", () => {
    expect(reconcileBulkUpdate(rows, new Set(), { status: "published" }, "t1")).toEqual(rows);
  });

  test("does not mutate the input rows", () => {
    const snapshot = JSON.parse(JSON.stringify(rows));
    reconcileBulkUpdate(rows, new Set(["a"]), { status: "published" }, "t1");
    expect(rows).toEqual(snapshot);
  });
});
