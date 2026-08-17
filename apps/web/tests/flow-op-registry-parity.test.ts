/**
 * An operation type lives in six hand-kept lists, and none of them forces the
 * others.
 *
 * That is not a style complaint — it is a measured failure mode, and each
 * omission fails in its own quiet way:
 *
 * | forgotten | what happens |
 * |---|---|
 * | `OPERATION_TYPES` | nothing, until a bundled template uses the op |
 * | the zod branch | REST 422s the op while GraphQL saves it, because `operations` is an opaque JSON scalar there |
 * | the executor branch | **the step runs, returns `undefined`, and the flow reports `ok: true`** |
 * | `SUPPORTED_ACTIONS` | the step is dropped on save with a warning nobody reads |
 * | the palette | the op cannot be added in the builder at all |
 * | `describeOpShort` | the flows list prints the raw type string instead of a summary |
 *
 * Only the second one is even a type error, and only on one surface. When this
 * gate was written, `describeOpShort` was already missing FIVE op types and the
 * OpenAPI description had drifted to naming 13 of 25 — nobody noticed either,
 * because nothing was looking.
 *
 * Style is lifted from `sdk-surfaces.test.ts`: read the sources, extract with
 * anchored regexes, and assert in both directions so an entry that names a type
 * which no longer exists fails too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");

/** Drop `//` line comments so a type name mentioned in prose is not read as an
 *  entry — `SUPPORTED_ACTIONS` carries two such comments today. */
const uncommented = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

/** The block a `const NAME = [ … ]` / `new Set([ … ])` declaration holds. */
const block = (src: string, re: RegExp): string => {
  const m = src.match(re);
  if (!m?.[1]) throw new Error(`could not find ${re}`);
  return uncommented(m[1]);
};

const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);

// ---------------------------------------------------------------------------
// The six lists
// ---------------------------------------------------------------------------

const CORE = read("packages", "core", "src", "flows.ts");
const EXEC = read("apps", "web", "src", "server", "services", "flows.ts");
const GRAPH = read("apps", "web", "src", "client", "admin", "pages", "automation", "flow-graph.ts");
const BUILDER = read("apps", "web", "src", "client", "admin", "pages", "automation", "flow-builder.tsx");
const FLOWS_PAGE = read("apps", "web", "src", "client", "admin", "pages", "automation", "flows.tsx");

/** THE canonical list. Everything below is measured against it. */
const canonical = quoted(block(CORE, /export const OPERATION_TYPES[^=]*=\s*\[([\s\S]*?)\];/));

const zodLiterals = new Set(
  [...CORE.matchAll(/type:\s*z\.literal\("([^"]+)"\)/g)].map((m) => m[1] as string),
);

const executorBranches = new Set(
  [...EXEC.matchAll(/op\.type === "([^"]+)"/g)].map((m) => m[1] as string),
);

const supportedActions = new Set(
  quoted(block(GRAPH, /const SUPPORTED_ACTIONS = new Set\(\[([\s\S]*?)\]\)/)),
);

/** Palette entries, with the ones declared `pending` held aside — a `pending`
 *  id is a control the runtime does not implement yet and deliberately has no
 *  operation type (`try` today). */
const paletteEntries = (name: string): { id: string; pending: boolean }[] => {
  const body = block(BUILDER, new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
  return [...body.matchAll(/\{([^}]*)\}/g)].map((m) => {
    const entry = m[1] as string;
    return {
      id: (entry.match(/id: "([^"]+)"/) ?? [])[1] as string,
      pending: /\bpending:/.test(entry),
    };
  });
};

const describedCases = new Set(
  [
    ...((FLOWS_PAGE.match(/function describeOpShort[\s\S]*?\n}/) ?? [""])[0] as string).matchAll(
      /case "([^"]+)":/g,
    ),
  ].map((m) => m[1] as string),
);

/**
 * Builder node id → operation type, for the two that deliberately differ.
 *
 * The builder is not obliged to name a node after its operation, and two
 * predate the convention. They are written down here rather than pattern-matched
 * because the alternative — a rule like "strip to three letters" — would let a
 * third rename in silently, and a node id that matches nothing is exactly the
 * shape of the `fn` bug: `synthesize` sets `type: op.type` for a flow with no
 * saved layout, producing a `function` node no inspector block matches.
 */
const NODE_ID_ALIASES: Record<string, string> = { fn: "function", if: "condition" };
const deAlias = (id: string) => NODE_ID_ALIASES[id] ?? id;

/**
 * Operation types the builder compiles through `compileNode`'s OWN branches
 * rather than the action path, so `SUPPORTED_ACTIONS` — which gates only
 * `kind === "action"` — correctly does not list them.
 *
 * Declared rather than inferred, and then checked below against the literals
 * `flow-graph.ts` actually emits, so this cannot become a list of things
 * somebody merely believes are handled.
 */
const CONTROL_OPS = ["condition", "foreach"];

describe("flow operation registry — six lists, one truth", () => {
  test("the canonical list is not empty and has no duplicates", () => {
    expect(canonical.length).toBeGreaterThanOrEqual(25);
    expect(new Set(canonical).size).toBe(canonical.length);
  });

  test("every operation type has a zod branch, and every zod branch is a real type", () => {
    // Forgetting this is not a type error — a `z.lazy` discriminated union
    // annotated as `z.ZodType<Operation>` compiles with a member missing. The
    // symptom is asymmetric: REST refuses the op, GraphQL stores it.
    expect(canonical.filter((t) => !zodLiterals.has(t))).toEqual([]);
    expect([...zodLiterals].filter((t) => !canonical.includes(t))).toEqual([]);
  });

  test("every operation type has an executor branch", () => {
    // The loudest failure of the six and the quietest symptom: `executeOp` is a
    // flat `if` chain ending in a bare `return undefined`, so a type nobody
    // implemented RUNS, produces nothing, and the run reports `ok: true`.
    expect(canonical.filter((t) => !executorBranches.has(t))).toEqual([]);
  });

  test("every executor branch is a real operation type", () => {
    expect([...executorBranches].filter((t) => !canonical.includes(t))).toEqual([]);
  });

  test("the builder compiles every operation type", () => {
    // Absent from `SUPPORTED_ACTIONS`, an action step is dropped on save with a
    // `Skipped unknown action` warning and the flow saves without it.
    const compilable = new Set([...[...supportedActions].map(deAlias), ...CONTROL_OPS]);
    expect(canonical.filter((t) => !compilable.has(t))).toEqual([]);
  });

  test("every id the builder can compile is a real operation type", () => {
    expect([...supportedActions].map(deAlias).filter((t) => !canonical.includes(t))).toEqual([]);
  });

  test("a control op is one the compiler really emits, not one we assume it does", () => {
    // `CONTROL_OPS` excuses a type from `SUPPORTED_ACTIONS`, so an entry nobody
    // compiles would be a hole with a comment over it.
    for (const op of CONTROL_OPS) {
      expect(`${op} emitted by flow-graph: ${GRAPH.includes(`type: "${op}"`)}`).toBe(
        `${op} emitted by flow-graph: true`,
      );
      expect(`${op} is a real operation type: ${canonical.includes(op)}`).toBe(
        `${op} is a real operation type: true`,
      );
      expect(`${op} is not also an action: ${!supportedActions.has(op)}`).toBe(
        `${op} is not also an action: true`,
      );
    }
  });

  test("every operation type can be added from the palette", () => {
    const offered = new Set(
      [...paletteEntries("ACTIONS"), ...paletteEntries("CONTROLS")]
        .filter((e) => !e.pending)
        .map((e) => deAlias(e.id)),
    );
    expect(canonical.filter((t) => !offered.has(t))).toEqual([]);
  });

  test("every palette id is a real operation type, or is declared pending", () => {
    const stray = [...paletteEntries("ACTIONS"), ...paletteEntries("CONTROLS")]
      .filter((e) => !e.pending && !canonical.includes(deAlias(e.id)))
      .map((e) => e.id);
    expect(stray).toEqual([]);
  });

  test("the flows list can summarise every operation type", () => {
    // `describeOpShort`'s `default` returns the raw type string, so a missing
    // case is a step whose preview reads `document.render` where every other
    // step reads what it does. Five were missing when this test was written.
    expect(canonical.filter((t) => !describedCases.has(t))).toEqual([]);
  });

  test("every summary case is a real operation type", () => {
    expect([...describedCases].filter((t) => !canonical.includes(t))).toEqual([]);
  });

  test("an alias is only written down for a node id that really differs", () => {
    // An alias whose two halves are equal, or whose target is not a real type,
    // is a rule with nothing to do — and a place a future rename could hide.
    for (const [nodeId, type] of Object.entries(NODE_ID_ALIASES)) {
      expect(`${nodeId} -> ${type}: distinct=${nodeId !== type}`).toBe(
        `${nodeId} -> ${type}: distinct=true`,
      );
      expect(`${nodeId} -> ${type}: real=${canonical.includes(type)}`).toBe(
        `${nodeId} -> ${type}: real=true`,
      );
    }
  });
});
