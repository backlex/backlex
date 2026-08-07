/**
 * Builder ↔ runtime translation for the `sms` and `push` steps.
 *
 * `sms` is the only action with two mutually exclusive addressing modes, so the
 * round-trip carries a derived field: the builder holds `mode`, the operation
 * holds either `to` or `userId`, and `decompileGraph` has to reconstruct the
 * toggle from whichever one is present. A drift there silently flips a step
 * from "text the customer" to "text the user" on the next edit.
 *
 * `push` had no builder entry at all before this — it compiled to nothing with
 * an "unknown step" warning — so these also pin its arrival.
 */
import { describe, expect, test } from "bun:test";
import { compileGraph, decompileGraph, type Graph } from "../../src/client/admin/pages/automation/flow-graph";

const graphWith = (type: string, config: Record<string, unknown>): Graph => ({
  nodes: [
    { id: "n1", kind: "trigger", type: "item.created", x: 0, y: 0, config: { collection: "appointments", when: "" } },
    { id: "n2", kind: "action", type, x: 260, y: 0, config },
  ],
  edges: [{ from: "n1", to: "n2", branch: null }],
});

const smsGraph = (config: Record<string, unknown>) => graphWith("sms", config);

describe("sms step — compile", () => {
  test("`to` mode emits the number and never a userId", () => {
    const out = compileGraph(
      smsGraph({ mode: "to", to: "{{ data.phone }}", userId: "", body: "See you at {{ data.starts_at }}", from: "" }),
    );
    expect(out.warnings).toEqual([]);
    expect(out.operations).toEqual([
      { type: "sms", body: "See you at {{ data.starts_at }}", to: "{{ data.phone }}" },
    ]);
  });

  test("`user` mode emits the userId and never a `to`", () => {
    const out = compileGraph(
      smsGraph({ mode: "user", to: "{{ data.phone }}", userId: "{{ data.author }}", body: "hi", from: "" }),
    );
    // The stale `to` from the other mode must not ride along — the operation
    // schema rejects an op carrying both.
    expect(out.operations).toEqual([{ type: "sms", body: "hi", userId: "{{ data.author }}" }]);
  });

  test("carries the optional sender override", () => {
    const out = compileGraph(smsGraph({ mode: "to", to: "+14155552671", body: "hi", from: "BACKLEX" }));
    expect(out.operations[0]).toEqual({ type: "sms", body: "hi", to: "+14155552671", from: "BACKLEX" });
  });

  test("an absent mode defaults to the row-carried number", () => {
    const out = compileGraph(smsGraph({ to: "+14155552671", body: "hi" }));
    expect(out.operations[0]).toEqual({ type: "sms", body: "hi", to: "+14155552671" });
  });

  test("a missing message or recipient is a compile error, not a silent skip", () => {
    expect(() => compileGraph(smsGraph({ mode: "to", to: "+14155552671", body: "" }))).toThrow(/needs a message/);
    expect(() => compileGraph(smsGraph({ mode: "to", to: "", body: "hi" }))).toThrow(/needs a recipient number/);
    expect(() => compileGraph(smsGraph({ mode: "user", userId: "", body: "hi" }))).toThrow(/needs a recipient user/);
  });
});

const back = (operations: unknown[]) =>
  decompileGraph({ trigger: "item.created:appointments", operations: operations as never });

describe("sms step — decompile", () => {
  test("reconstructs the `to` toggle from an op with no userId", () => {
    const node = back([{ type: "sms", body: "hi", to: "{{ data.phone }}" }]).nodes.find((n) => n.type === "sms");
    expect(node?.config).toMatchObject({ mode: "to", to: "{{ data.phone }}", userId: "" });
  });

  test("reconstructs the `user` toggle from an op with a userId", () => {
    const node = back([{ type: "sms", body: "hi", userId: "u1" }]).nodes.find((n) => n.type === "sms");
    expect(node?.config).toMatchObject({ mode: "user", userId: "u1", to: "" });
  });

  test("round-trips both modes without losing config", () => {
    for (const op of [
      { type: "sms", body: "hi", to: "{{ data.phone }}", from: "BACKLEX" },
      { type: "sms", body: "hi", userId: "{{ data.author }}" },
    ]) {
      expect(compileGraph(back([op])).operations[0]).toEqual(op);
    }
  });
});

describe("push step", () => {
  test("compiles and round-trips", () => {
    const op = { type: "push", title: "Booked", body: "See you soon", userId: "{{ data.author }}", url: "/a/{{ data.id }}" };
    const out = compileGraph(graphWith("push", { title: "Booked", body: "See you soon", userId: "{{ data.author }}", url: "/a/{{ data.id }}" }));
    expect(out.warnings).toEqual([]);
    expect(out.operations[0]).toEqual(op);
    expect(compileGraph(back([op])).operations[0]).toEqual(op);
  });

  test("omits a blank url rather than emitting an empty string", () => {
    const out = compileGraph(graphWith("push", { title: "t", body: "b", userId: "u1", url: "" }));
    expect(out.operations[0]).toEqual({ type: "push", title: "t", body: "b", userId: "u1" });
  });

  test("every required field is a compile error when missing", () => {
    expect(() => compileGraph(graphWith("push", { title: "", body: "b", userId: "u1" }))).toThrow(/needs a Title/);
    expect(() => compileGraph(graphWith("push", { title: "t", body: "", userId: "u1" }))).toThrow(/needs a message/);
    expect(() => compileGraph(graphWith("push", { title: "t", body: "b", userId: "" }))).toThrow(/needs a recipient user/);
  });
});
