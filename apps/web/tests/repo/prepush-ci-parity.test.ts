/**
 * Every script CI runs to judge a commit, the pre-push hook runs too.
 *
 * `lefthook.yml`'s pre-push block opens with "full CI parity … any green-here /
 * red-there divergence is a CI bug." That was aspirational: the hook was
 * missing `typecheck:tests`, `build:examples` and the SDK's tsup `.d.ts` build.
 * PR #351 passed the whole ~190s local gate and went red on the first of those.
 * A gate that claims parity and does not have it sends the next reader looking
 * for a CI bug that is not there. See #352.
 *
 * WHAT IS COMPARED. `bun run <script>` invocations, derived from both files —
 * not a hand-written list, so a step added to CI is caught by the same rule
 * that catches one removed from the hook.
 *
 * WHAT IS NOT, and this is the honest limit rather than a footnote. The CI side
 * is read from two named jobs, `test` and `build` — the two whose failure means
 * the COMMIT is wrong. A brand-new correctness job would not be seen.
 *
 * The alternative was to read every job and exempt the rest, and that trade is
 * worse: `supply-chain` audits the dependency tree rather than the diff,
 * `runtime-smoke` needs the build artefact and fans out eight ways, and
 * `deploy` is not a check at all — so it needs an exception list, and an
 * exception list is exactly the thing that quietly stops meaning anything as
 * the code it excuses moves. Two named jobs and a stated limit beats a list.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The bun script a `run:` line invokes, or null when it is not one.
 *
 *  `--cwd <dir>` is part of the identity: `bun run --cwd packages/client build`
 *  is a different job from `bun run build`, and collapsing them would let the
 *  root build stand in for the SDK's `.d.ts` build.
 *
 *  `--cwd` is the ONE flag whose value is space-separated, and it is spelled
 *  out here rather than covered by a generic `--flag <value>` alternative. That
 *  generic version is wrong and this test caught it doing the wrong thing on
 *  its first run: in `bun run --no-orphans --cwd packages/client build`, a
 *  valueless flag followed by a valued one lets `--no-orphans` swallow ` --cwd`
 *  as its value, and the script parses as `packages`. Every other flag here
 *  joins its value with `=`. */
const scriptOf = (line: string): string | null => {
  const m = /\bbun\s+run\s+((?:--(?:cwd\s+\S+|[\w-]+(?:=\S+)?)\s+)*)([\w:.-]+)/.exec(line);
  if (!m) return /\bbun\s+test\b/.test(line) ? "test" : null;
  const cwd = /--cwd\s+(\S+)/.exec(m[1] ?? "");
  return cwd ? `${cwd[1]}:${m[2]}` : (m[2] ?? null);
};

/** Every `run:` line inside one top-level job of a GitHub workflow.
 *
 *  Deliberately a line scan rather than a YAML parse: the workflow's own
 *  indentation is the structure, and pulling in a parser to read four lines
 *  would be its own thing to keep working. Job boundaries are two-space keys. */
const ciScripts = (yaml: string, job: string): string[] => {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^ {2}[\w-]+:/.test(l)) break; // next top-level job
    const s = scriptOf(l);
    if (s) out.push(s);
  }
  return [...new Set(out)];
};

/** Every script the pre-push hook runs. */
const hookScripts = (yaml: string): string[] => {
  const lines = yaml.split("\n");
  const start = lines.indexOf("pre-push:");
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^[\w-]+:/.test(l)) break; // next top-level hook
    const s = scriptOf(l);
    if (s) out.push(s);
  }
  return [...new Set(out)];
};

const WORKFLOW = read(".github/workflows/test.yml");
const LEFTHOOK = read("lefthook.yml");

/** The jobs whose failure means the commit is wrong. See the header. */
const CORRECTNESS_JOBS = ["test", "build"] as const;

describe("the pre-push hook runs what CI runs", () => {
  const hook = hookScripts(LEFTHOOK);

  test("the parsers still see both files (the vacuous-pass guard)", () => {
    // Without this, a change to either file's shape makes both sides empty and
    // "no missing scripts" passes while checking nothing — the exact failure
    // this test exists to prevent, one level up.
    expect(hook.length, "no scripts parsed out of lefthook.yml's pre-push").toBeGreaterThanOrEqual(
      4,
    );
    for (const job of CORRECTNESS_JOBS) {
      expect(
        ciScripts(WORKFLOW, job).length,
        `no scripts parsed out of test.yml's \`${job}\` job`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  test("the matcher actually matches (the second vacuous-pass guard)", () => {
    // A regex that stopped matching would report empty sets on both sides and
    // agree perfectly. These two are named because they have run in both places
    // since long before this test, so their absence means the parser broke, not
    // that the repo changed.
    expect(hook).toContain("typecheck");
    expect(ciScripts(WORKFLOW, "test")).toContain("typecheck");
  });

  for (const job of CORRECTNESS_JOBS) {
    test(`every script test.yml's \`${job}\` job runs is in the hook`, () => {
      const missing = ciScripts(WORKFLOW, job).filter((s) => !hook.includes(s));
      expect(
        missing,
        `test.yml's \`${job}\` job runs ${missing.join(", ")}, which the pre-push ` +
          "hook does not. Either add it to lefthook.yml's pre-push jobs, or — if " +
          "it genuinely cannot run locally — move it to a job outside " +
          `${CORRECTNESS_JOBS.join("/")} and say why in this file's header.`,
      ).toEqual([]);
    });
  }

  test("--cwd is part of a script's identity", () => {
    // The SDK's tsup build is `bun run --cwd packages/client build`. If `--cwd`
    // were dropped from the key it would collapse into the root `build`, and
    // the hook would appear to run the .d.ts build while running something
    // else entirely — a pass that means the opposite of what it says.
    expect(scriptOf("        run: bun run --cwd packages/client build")).toBe(
      "packages/client:build",
    );
    // The exact line that broke the first version of the regex: a valueless
    // flag in front of a valued one. Parsed `packages` before, which made the
    // hook and CI look like they ran different scripts when they ran the same.
    expect(scriptOf("      run: bun run --no-orphans --cwd packages/client build")).toBe(
      "packages/client:build",
    );
    expect(scriptOf("        run: bun run build")).toBe("build");
    expect(scriptOf("      run: bun run --no-orphans typecheck:tests")).toBe("typecheck:tests");
    expect(scriptOf("      - uses: actions/checkout@v5")).toBeNull();
  });
});
