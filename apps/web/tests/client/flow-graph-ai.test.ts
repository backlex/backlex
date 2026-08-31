/**
 * Builder ↔ runtime translation for the two AI steps.
 *
 * `ai.classify` carries the awkward half: the operation stores `labels` as an
 * array because that is what a schema can check, and the inspector edits it as
 * one newline-separated field because a repeating row editor for a list of
 * short strings is more chrome than the thing it edits. So the split and the
 * join are a translation, and a translation is exactly where a config quietly
 * loses a label on the next edit.
 *
 * The rest is the shape every step in this file shares and every step gets
 * wrong once: an optional field that is blank must be OMITTED, not emitted as
 * an empty string. `model: ""` does not mean "the workspace default" to the
 * runtime — it means a model with no name.
 */
import { describe, expect, test } from "bun:test";
import { compileGraph, decompileGraph, type Graph } from "../../src/client/admin/pages/automation/flow-graph";
import type { Operation } from "@backlex/core";

const graphWith = (type: string, config: Record<string, unknown>): Graph => ({
  nodes: [
    { id: "n1", kind: "trigger", type: "item.created", x: 0, y: 0, config: { collection: "tickets", when: "" } },
    { id: "n2", kind: "action", type, x: 260, y: 0, config },
  ],
  edges: [{ from: "n1", to: "n2", branch: null }],
});

const back = (operations: unknown[]) =>
  decompileGraph({ trigger: "item.created:tickets", operations: operations as never });

describe("ai.generate step — compile", () => {
  test("emits the prompt and omits every blank optional", () => {
    const out = compileGraph(
      graphWith("ai.generate", {
        prompt: "Summarise: {{ data.body }}",
        system: "",
        model: "",
        maxTokens: "",
        effort: "",
      }),
    );
    expect(out.warnings).toEqual([]);
    // No `model: ""`, no `maxTokens: NaN`, no `effort: ""` — the runtime reads
    // an absent field as "the workspace default" and a present blank one as a
    // value it must honour.
    expect(out.operations).toEqual([{ type: "ai.generate", prompt: "Summarise: {{ data.body }}" }]);
  });

  test("carries the optionals that were filled in", () => {
    const out = compileGraph(
      graphWith("ai.generate", {
        prompt: "hi",
        system: "You are terse.",
        model: "anthropic/claude-haiku-4-5",
        maxTokens: "256",
        effort: "low",
      }),
    );
    expect(out.operations[0]).toEqual({
      type: "ai.generate",
      prompt: "hi",
      system: "You are terse.",
      model: "anthropic/claude-haiku-4-5",
      // The inspector's Input hands back a string; the op declares a number.
      maxTokens: 256,
      effort: "low",
    });
  });

  test("a non-numeric or non-positive token budget is dropped, not emitted", () => {
    for (const maxTokens of ["", "abc", "0", "-5"]) {
      const out = compileGraph(graphWith("ai.generate", { prompt: "hi", maxTokens }));
      expect(out.operations[0]).toEqual({ type: "ai.generate", prompt: "hi" });
    }
  });

  test("an unrecognised effort is dropped rather than sent to the provider", () => {
    const out = compileGraph(graphWith("ai.generate", { prompt: "hi", effort: "extreme" }));
    expect(out.operations[0]).toEqual({ type: "ai.generate", prompt: "hi" });
  });

  test("a missing prompt is a compile error, not a silent skip", () => {
    expect(() => compileGraph(graphWith("ai.generate", { prompt: "   " }))).toThrow(/needs a prompt/);
  });
});

describe("ai.classify step — compile", () => {
  const labels = "billing\ntechnical\nother";

  test("splits the label field into the array the op declares", () => {
    const out = compileGraph(
      graphWith("ai.classify", { input: "{{ data.subject }}", labels, instructions: "", model: "", fallback: "" }),
    );
    expect(out.warnings).toEqual([]);
    expect(out.operations).toEqual([
      { type: "ai.classify", input: "{{ data.subject }}", labels: ["billing", "technical", "other"] },
    ]);
  });

  test("blank lines and stray whitespace are not labels", () => {
    const out = compileGraph(
      graphWith("ai.classify", { input: "x", labels: "  billing  \n\n technical \n   \n" }),
    );
    expect(out.operations[0]).toMatchObject({ labels: ["billing", "technical"] });
  });

  test("fewer than two labels is a compile error", () => {
    expect(() => compileGraph(graphWith("ai.classify", { input: "x", labels: "billing" }))).toThrow(
      /at least two labels/,
    );
    expect(() => compileGraph(graphWith("ai.classify", { input: "x", labels: "" }))).toThrow(
      /at least two labels/,
    );
  });

  test("labels differing only in case are refused here, not discovered at run time", () => {
    // The executor folds before matching, so these two are one label with two
    // spellings and which one lands on `$last.label` would be a coin toss.
    expect(() =>
      compileGraph(graphWith("ai.classify", { input: "x", labels: "Billing\nbilling" })),
    ).toThrow(/distinct/);
  });

  test("a fallback outside the label set is refused", () => {
    expect(() =>
      compileGraph(graphWith("ai.classify", { input: "x", labels, fallback: "escalate" })),
    ).toThrow(/fallback must be one of/);
  });

  test("a fallback that matches a label by case only is accepted", () => {
    const out = compileGraph(graphWith("ai.classify", { input: "x", labels, fallback: "Other" }));
    expect(out.operations[0]).toMatchObject({ fallback: "Other" });
  });

  test("a missing input is a compile error", () => {
    expect(() => compileGraph(graphWith("ai.classify", { input: "", labels }))).toThrow(/text to classify/);
  });
});

describe("both AI steps — decompile and round-trip", () => {
  test("ai.generate rehydrates its panel from an op with no layout", () => {
    const node = back([{ type: "ai.generate", prompt: "hi", model: "anthropic/claude-haiku-4-5" }]).nodes.find(
      (n) => n.type === "ai.generate",
    );
    // Blank strings, not undefined: the inspector binds controlled inputs.
    expect(node?.config).toMatchObject({
      prompt: "hi",
      model: "anthropic/claude-haiku-4-5",
      system: "",
      maxTokens: "",
      effort: "",
    });
  });

  test("ai.classify rejoins the array into the field the inspector edits", () => {
    const node = back([{ type: "ai.classify", input: "x", labels: ["billing", "technical"] }]).nodes.find(
      (n) => n.type === "ai.classify",
    );
    expect(node?.config).toMatchObject({ input: "x", labels: "billing\ntechnical", fallback: "" });
  });

  test("both round-trip without losing config", () => {
    const cases: Operation[] = [
      { type: "ai.generate", prompt: "hi" },
      { type: "ai.generate", prompt: "hi", system: "terse", model: "m", maxTokens: 256, effort: "high" },
      { type: "ai.classify", input: "x", labels: ["a", "b"] },
      { type: "ai.classify", input: "x", labels: ["a", "b"], instructions: "why", model: "m", fallback: "b" },
    ];
    for (const op of cases) {
      expect(compileGraph(back([op])).operations[0]).toEqual(op);
    }
  });
});
