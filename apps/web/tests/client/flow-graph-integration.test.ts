/**
 * Builder ↔ runtime translation for the `integration` step.
 *
 * `compileGraph` and `decompileGraph` are inverses; a drift between them shows
 * up as a step that silently loses its config on the next edit. Nothing covered
 * this layer before, so these also pin the `slack` placeholder's replacement:
 * that entry used to compile to nothing at all with a "phase 2" warning.
 */
import { describe, expect, test } from "bun:test";
import { compileGraph, decompileGraph, type Graph } from "../../src/client/admin/pages/automation/flow-graph";

const graphWith = (config: Record<string, unknown>): Graph => ({
  nodes: [
    { id: "n1", kind: "trigger", type: "item.created", x: 0, y: 0, config: { collection: "orders", when: "" } },
    { id: "n2", kind: "action", type: "integration", x: 260, y: 0, config },
  ],
  edges: [{ from: "n1", to: "n2", branch: null }],
});

describe("integration step — compile", () => {
  test("compiles the provider, message, event label and payload", () => {
    const out = compileGraph(
      graphWith({ kind: "slack", text: "Order {{ data.id }}", event: "order.shipped", payload: '{"id":"{{ data.id }}"}' }),
    );
    expect(out.warnings).toEqual([]);
    expect(out.operations).toEqual([
      {
        type: "integration",
        kind: "slack",
        text: "Order {{ data.id }}",
        event: "order.shipped",
        payload: '{"id":"{{ data.id }}"}',
      },
    ]);
  });

  test("omits the optional fields when they are blank", () => {
    const out = compileGraph(graphWith({ kind: "slack", text: "hi", event: "", payload: "" }));
    expect(out.operations[0]).toEqual({ type: "integration", kind: "slack", text: "hi" });
  });

  test("a missing provider or message is a compile error, not a silent skip", () => {
    expect(() => compileGraph(graphWith({ kind: "", text: "hi" }))).toThrow(/needs a provider/);
    expect(() => compileGraph(graphWith({ kind: "slack", text: "" }))).toThrow(/needs a message/);
  });

  test("the step is no longer treated as an unsupported placeholder", () => {
    const out = compileGraph(graphWith({ kind: "slack", text: "hi" }));
    // The old `slack` entry emitted a "phase 2" warning and compiled to [].
    expect(out.warnings).toEqual([]);
    expect(out.operations).toHaveLength(1);
  });
});

describe("integration step — round-trip", () => {
  test("decompile restores every field the inspector edits", () => {
    const config = {
      kind: "jira",
      text: "New order",
      event: "order.created",
      payload: '{"id":"1"}',
    };
    const compiled = compileGraph(graphWith(config));
    const back = decompileGraph({
      trigger: compiled.trigger,
      operations: compiled.operations,
      layout: null,
    } as never);
    const step = back.nodes.find((n) => n.type === "integration");
    expect(step).toBeDefined();
    expect(step!.config).toMatchObject(config);
  });

  test("an object payload round-trips as pretty JSON the textarea can show", () => {
    const back = decompileGraph({
      trigger: "event:items:orders:created",
      operations: [{ type: "integration", kind: "slack", text: "hi", payload: { id: "1" } }],
      layout: null,
    } as never);
    const step = back.nodes.find((n) => n.type === "integration")!;
    expect(step.config.payload).toBe(JSON.stringify({ id: "1" }, null, 2));
    // An absent payload must become "" rather than "undefined" in the field.
    const bare = decompileGraph({
      trigger: "event:items:orders:created",
      operations: [{ type: "integration", kind: "slack", text: "hi" }],
      layout: null,
    } as never);
    expect(bare.nodes.find((n) => n.type === "integration")!.config.payload).toBe("");
  });
});
