import { describe, expect, test } from "bun:test";
import { resolveKanbanGroupField, resolveStatusField } from "../../src/client/admin/items";

// Pure-logic unit tests for the Kanban group-by resolvers. The bunfig preloads
// (lingui-macro + happy-dom) let items.tsx import cleanly under bun test.

const dropdown = (name: string, values: string[]) => ({
  name,
  type: "text",
  interface: "dropdown",
  options: { values },
});

describe("resolveStatusField — table + base resolver", () => {
  test("prefers a field literally named status", () => {
    const r = resolveStatusField({
      fields: [dropdown("priority", ["lo", "hi"]), dropdown("status", ["draft", "live"])],
    });
    expect(r?.name).toBe("status");
  });

  test("kanbanGroupBy points it at another dropdown field", () => {
    const r = resolveStatusField({
      kanbanGroupBy: "priority",
      fields: [dropdown("status", ["draft", "live"]), dropdown("priority", ["lo", "hi"])],
    } as never);
    expect(r?.name).toBe("priority");
  });

  test("never resolves the Kanban-only _status sentinel (would break inline edit)", () => {
    const r = resolveStatusField({
      kanbanGroupBy: "_status",
      versioned: true,
      fields: [dropdown("stage", ["a", "b"])],
    } as never);
    // Falls through to auto-detect (the first dropdown), never `_status`.
    expect(r?.name).toBe("stage");
  });

  test("returns null when there is no dropdown field", () => {
    expect(resolveStatusField({ fields: [{ name: "title", type: "text" }] })).toBeNull();
  });

  test("a stale kanbanGroupBy (renamed field) falls back to auto-detect", () => {
    const r = resolveStatusField({
      kanbanGroupBy: "ghost",
      fields: [dropdown("status", ["draft", "live"])],
    } as never);
    expect(r?.name).toBe("status");
  });
});

describe("resolveKanbanGroupField — Kanban-only lifecycle axis", () => {
  test("_status on a versioned collection yields the draft/published/archived lifecycle", () => {
    const r = resolveKanbanGroupField({ kanbanGroupBy: "_status", versioned: true, fields: [] });
    expect(r?.name).toBe("_status");
    expect(r?.choices.map((c) => c.value)).toEqual(["draft", "published", "archived"]);
  });

  test("_status without versioned falls back to the base resolver", () => {
    const r = resolveKanbanGroupField({
      kanbanGroupBy: "_status",
      versioned: false,
      fields: [dropdown("stage", ["a", "b"])],
    });
    expect(r?.name).toBe("stage");
  });

  test("a custom dropdown groups the board on that field", () => {
    const r = resolveKanbanGroupField({
      kanbanGroupBy: "stage",
      versioned: true,
      fields: [dropdown("stage", ["a", "b"])],
    });
    expect(r?.name).toBe("stage");
    expect(r?.choices.map((c) => c.value)).toEqual(["a", "b"]);
  });
});
