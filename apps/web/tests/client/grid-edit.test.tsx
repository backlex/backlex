/**
 * Spreadsheet grid mode on the items table (roadmap #14).
 *
 * The grid layer (grid-edit.tsx) turns the table into a cell grid: click
 * selects, shift/drag extends, arrows navigate, typing edits, ⌘C/⌘V move TSV
 * through the clipboard, ⌘D fills down, ⌫ clears. Writes route through
 * `useItemsGridWrite`: a uniform patch collapses to one `/bulk-update` call,
 * mixed patches go through `/batch` update ops — both optimistic.
 *
 * These specs pin the pure clipboard helpers plus the full interaction loop
 * over a fetch-mocked ItemsTable: selection rectangle → copy payload,
 * fill-down → bulk-update request, TSV paste → batch request, type-to-edit
 * seeding, and row-click NOT opening the editor while grid mode is on.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ItemsTable } from "../../src/client/admin/items";
import { coerce, parseTsv, type GridColumn } from "../../src/client/admin/grid-edit";
import { renderWithProviders } from "./render";

const col = (over: Partial<GridColumn>): GridColumn => ({
  name: "x",
  editable: true,
  raw: () => null,
  ...over,
});

describe("grid clipboard helpers", () => {
  test("parseTsv splits rows/cells and strips the one trailing newline", () => {
    expect(parseTsv("a\tb\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    // CRLF (Excel on Windows) and embedded empties survive.
    expect(parseTsv("a\t\r\nb\t\r\n")).toEqual([
      ["a", ""],
      ["b", ""],
    ]);
  });

  test("coerce maps text to the column's storage type", () => {
    expect(coerce("42.9", col({ type: "integer" }))).toEqual({ ok: true, value: 42 });
    expect(coerce("42.9", col({ type: "number" }))).toEqual({ ok: true, value: 42.9 });
    expect(coerce("", col({ type: "integer" }))).toEqual({ ok: true, value: null });
    expect(coerce("abc", col({ type: "integer" }))).toEqual({ ok: false });
    expect(coerce("yes", col({ type: "boolean" }))).toEqual({ ok: true, value: true });
    expect(coerce("0", col({ type: "boolean" }))).toEqual({ ok: true, value: false });
    expect(coerce("hi", col({ type: "text" }))).toEqual({ ok: true, value: "hi" });
  });

  test("coerce matches dropdown choices by value or label, case-insensitively", () => {
    const c = col({ choices: [{ value: "draft" }, { value: "published", label: "Live" }] });
    expect(coerce("DRAFT", c)).toEqual({ ok: true, value: "draft" });
    expect(coerce("live", c)).toEqual({ ok: true, value: "published" });
    expect(coerce("nope", c)).toEqual({ ok: false });
  });
});

// --- interaction specs over a real ItemsTable ------------------------------

// No title/name field and no display template → the table has NO synthetic
// identity column and auto-renders the first fields as (editable) columns —
// the simplest fully-editable grid to drive.
const SCHEMA = {
  slug: "t",
  ownerScoped: false,
  fields: [
    { name: "label", type: "text" },
    { name: "count", type: "integer" },
  ],
} as never;

const ROWS = [
  { id: "r1", label: "Alpha", count: 1, updated_at: "2026-07-01T00:00:00Z" },
  { id: "r2", label: "Beta", count: 2, updated_at: "2026-07-01T00:00:00Z" },
  { id: "r3", label: "Gamma", count: 3, updated_at: "2026-07-01T00:00:00Z" },
] as never[];

/** Every network call the table makes (settings, session, writes) lands here. */
let calls: Array<{ url: string; body?: unknown }>;
const realFetch = global.fetch;

beforeEach(() => {
  calls = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(
      JSON.stringify({ data: { total: 9, updated: 9, succeeded: 9, failed: 0, results: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  cleanup();
});

const noop = () => {};

const renderGrid = (onEdit: (r: unknown) => void = noop) =>
  renderWithProviders(
    <ItemsTable
      rows={ROWS}
      selected={new Set()}
      setSelected={noop}
      sort=""
      setSort={noop}
      onEdit={onEdit}
      schema={SCHEMA}
      gridMode
      onNotice={noop}
      onCellError={noop}
    />,
  );

/** The grid focus container is the wrapper div carrying tabindex=0. */
const container = (r: ReturnType<typeof renderGrid>) =>
  r.container.querySelector('div[tabindex="0"]') as HTMLElement;

const cellOf = (text: string) => screen.getByText(text).closest("td") as HTMLElement;

/** Minimal ClipboardEvent stand-in — happy-dom lacks a settable clipboardData. */
const clip = () => {
  const store = new Map<string, string>();
  return {
    setData: (k: string, v: string) => void store.set(k, v),
    getData: (k: string) => store.get(k) ?? "",
  };
};

describe("ItemsTable grid mode", () => {
  test("row click does not open the editor; cell click selects it", () => {
    const onEdit = mock(noop);
    renderGrid(onEdit);
    const cell = cellOf("Alpha");
    fireEvent.mouseDown(cell);
    fireEvent.click(cell);
    expect(onEdit).not.toHaveBeenCalled();
    expect(cell.hasAttribute("data-grid-selected")).toBe(true);
    expect(cell.hasAttribute("data-grid-focused")).toBe(true);
  });

  test("⌘C copies the shift-extended rectangle as TSV raw values", () => {
    const r = renderGrid();
    fireEvent.mouseDown(cellOf("Alpha"));
    fireEvent.mouseDown(cellOf("2"), { shiftKey: true }); // Beta's count cell
    const data = clip();
    fireEvent.copy(container(r), { clipboardData: data });
    expect(data.getData("text/plain")).toBe("Alpha\t1\nBeta\t2");
  });

  test("⌘D fill-down sends ONE uniform bulk-update", async () => {
    const r = renderGrid();
    // Select title column rows 1→3.
    fireEvent.mouseDown(cellOf("Alpha"));
    fireEvent.mouseDown(cellOf("Gamma"), { shiftKey: true });
    fireEvent.keyDown(container(r), { key: "d", metaKey: true });
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/items/t/bulk-update"))).toBe(true);
    });
    const call = calls.find((c) => c.url.includes("/bulk-update"))!;
    expect(call.body).toEqual({ keys: ["r2", "r3"], data: { label: "Alpha" } });
  });

  test("pasting a TSV block writes per-row batch update ops", async () => {
    const r = renderGrid();
    fireEvent.mouseDown(cellOf("Alpha"));
    const data = clip();
    data.setData("text/plain", "New1\t10\nNew2\t20");
    fireEvent.paste(container(r), { clipboardData: data });
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/items/t/batch"))).toBe(true);
    });
    const call = calls.find((c) => c.url.includes("/batch"))!;
    expect(call.body).toEqual({
      operations: [
        { op: "update", id: "r1", data: { label: "New1", count: 10 } },
        { op: "update", id: "r2", data: { label: "New2", count: 20 } },
      ],
    });
  });

  test("typing on a focused cell opens the editor seeded with the character", async () => {
    const r = renderGrid();
    fireEvent.mouseDown(cellOf("Alpha"));
    fireEvent.keyDown(container(r), { key: "Z" });
    const input = (await screen.findByDisplayValue("Z")) as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
  });

  test("⌫ clears the selected cells (uniform null → one bulk-update)", async () => {
    const r = renderGrid();
    fireEvent.mouseDown(cellOf("1"));
    fireEvent.mouseDown(cellOf("2"), { shiftKey: true });
    fireEvent.keyDown(container(r), { key: "Backspace" });
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/bulk-update"))).toBe(true);
    });
    const call = calls.find((c) => c.url.includes("/bulk-update"))!;
    expect(call.body).toEqual({ keys: ["r1", "r2"], data: { count: null } });
  });
});
