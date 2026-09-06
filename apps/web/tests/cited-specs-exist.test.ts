/**
 * A comment that names a test file is a claim, and this checks the claim.
 *
 * WHY THIS FILE EXISTS
 *
 * `middleware/plane-firewall.ts` said, in its docblock, that
 * `route-planes.test.ts` "asserts a violation is observable rather than
 * trusting that it would be". No such file has ever existed, and until phase
 * 10 of the 2026-09 audit nothing read that log line back at all. The sentence
 * was doing the work of a guard while no guard was there. PR #340 wrote the
 * missing spec and explained the whole thing — and left the wrong name in the
 * middleware, so a reader following the pointer still landed nowhere. Two more
 * turned up the moment anyone looked: `packages/cli/src/gen-types.ts` said its
 * index-signature shape was "pinned by tests/gen-types-index-signature.test.ts"
 * (the guard is real, it is `apps/web/tests/gen-types.test.ts`).
 *
 * That is the repo's house failure in its cheapest form: a claim nobody reads
 * back. It costs one scan to make the class impossible, so this file scans.
 *
 * WHAT IT ASSERTS
 *
 * Every `*.test.ts` / `*.spec.tsx` filename appearing anywhere in `apps/`,
 * `packages/` or `scripts/` source names a file that exists — matched on
 * basename, because most citations are written relative to somewhere else.
 *
 * THE ONE EXEMPTION, AND WHY IT IS NOT AN ALLOWLIST
 *
 * A citation is excused only when the prose around it SAYS the file is not
 * there ("has never existed", "does not exist"). `plane-boundary.test.ts` needs
 * that: naming the phantom file is the point of its docblock. This is derived
 * from what the comment says, not from a list of blessed names — a stale
 * exemption cannot accumulate here, because an ordinary broken pointer does not
 * come with a sentence announcing that it is broken. See the repo's own lesson
 * that exception lists launder defects.
 *
 * WHAT KEEPS IT HONEST
 *
 * A scan that stops matching reports zero violations, which looks exactly like
 * a clean tree. So the counts are asserted too, and `citationsIn` is exercised
 * against synthetic sources with known answers — cases that fail even when the
 * real tree is spotless.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * This file is the one source that must not be scanned: its docblock and its
 * synthetic cases below quote the phantom name on purpose, and a scanner that
 * reads its own fixtures reports them as findings. The exclusion is computed
 * from `import.meta.url`, so it can only ever mean THIS file — it is not a name
 * anyone else can be added to.
 */
const SELF = fileURLToPath(import.meta.url).slice(REPO_ROOT.length);

/** Phrases that turn a citation into a deliberate reference to something absent. */
const ABSENCE = /\b(?:never existed|does not exist|did not exist|no such file|was never written)\b/i;

/** How far past a citation the absence note may sit. One wrapped comment paragraph. */
const ABSENCE_WINDOW = 320;

export type Citation = { name: string; deliberatelyAbsent: boolean };

/**
 * Every spec filename mentioned in `source`.
 *
 * A leading `-` or `*` means the token is a suffix PATTERN naming a family of
 * files (`*-surfaces.test.ts`, `-pg.test.ts`), not a file, so it is not a claim
 * about anything and is skipped.
 */
export const citationsIn = (source: string): Citation[] => {
  const out: Citation[] = [];
  for (const m of source.matchAll(/[\w./-]+\.(?:test|spec)\.tsx?/g)) {
    const token = m[0];
    const name = token.split("/").pop() ?? token;
    if (name.startsWith("-") || name.startsWith("*")) continue;
    const after = source.slice(m.index + token.length, m.index + token.length + ABSENCE_WINDOW);
    out.push({ name, deliberatelyAbsent: ABSENCE.test(after) });
  }
  return out;
};

const realSpecNames = new Set<string>();
for await (const f of new Glob("**/*.{test,spec}.{ts,tsx}").scan({ cwd: REPO_ROOT, onlyFiles: true })) {
  if (f.includes("node_modules")) continue;
  realSpecNames.add(f.split("/").pop() ?? f);
}

type Dangling = { name: string; file: string };
const dangling: Dangling[] = [];
let filesScanned = 0;
let citationCount = 0;
let excused = 0;
let selfSkipped = 0;

for await (const f of new Glob("{apps,packages,scripts}/**/*.{ts,tsx}").scan({
  cwd: REPO_ROOT,
  onlyFiles: true,
})) {
  if (f.includes("node_modules")) continue;
  if (f === SELF) {
    selfSkipped++;
    continue;
  }
  filesScanned++;
  for (const c of citationsIn(await Bun.file(`${REPO_ROOT}${f}`).text())) {
    citationCount++;
    if (realSpecNames.has(c.name)) continue;
    if (c.deliberatelyAbsent) {
      excused++;
      continue;
    }
    dangling.push({ name: c.name, file: f });
  }
}

describe("a comment that names a spec names one that exists", () => {
  test("no source comment points at a spec file that is not there", () => {
    const listed = dangling.map((d) => `  ${d.file}\n      cites ${d.name}`).join("\n");
    expect(
      dangling.length === 0
        ? ""
        : `${dangling.length} comment${dangling.length === 1 ? "" : "s"} name a spec file that does not exist.\n` +
          `Point each at the spec that actually covers the behaviour — or, if the\n` +
          `absence is the point, say so in the sentence ("has never existed").\n${listed}\n`,
    ).toBe("");
  });

  test("it actually read the tree (a blind scan reports zero the same way)", () => {
    expect(filesScanned).toBeGreaterThan(1000);
    expect(realSpecNames.size).toBeGreaterThan(500);
    expect(citationCount).toBeGreaterThan(100);
  });

  test("the absence exemption stays rare enough to still be an exemption", () => {
    // Today: exactly one, `plane-boundary.test.ts` naming `route-planes.test.ts`.
    // A creeping number here means the phrase is being used as a mute button.
    expect(excused).toBeLessThanOrEqual(3);
  });

  test("exactly one file is skipped, and it is this one", () => {
    // If the glob ever stops reaching this file the exclusion is silently
    // pointless, and if it ever skips two the exclusion has grown into a list.
    expect(selfSkipped).toBe(1);
    expect(SELF).toBe("apps/web/tests/cited-specs-exist.test.ts");
  });
});

describe("the matcher, against sources with known answers", () => {
  test("a plain citation is a claim", () => {
    expect(citationsIn("// Pinned by tests/foo.test.ts.")).toEqual([
      { name: "foo.test.ts", deliberatelyAbsent: false },
    ]);
  });

  test("a .tsx spec counts — the first draft of this scan missed them and invented six failures", () => {
    expect(citationsIn("// see condition-editor.test.tsx")[0]?.name).toBe("condition-editor.test.tsx");
  });

  test("a suffix pattern names a family, not a file", () => {
    expect(citationsIn("// every *-surfaces.test.ts does this")).toEqual([]);
    expect(citationsIn("// the -pg.test.ts variants")).toEqual([]);
  });

  test("prose that says the file is absent excuses the citation", () => {
    const [c] = citationsIn(
      "/** The docblock claimed `route-planes.test.ts` covers it. That file\n * has never existed. */",
    );
    expect(c?.deliberatelyAbsent).toBe(true);
  });

  test("the excuse does not reach past its paragraph", () => {
    const far = `// cites ghost.test.ts\n${"// filler line\n".repeat(30)}// which has never existed`;
    expect(citationsIn(far)[0]?.deliberatelyAbsent).toBe(false);
  });

  test("the real defect shape is caught: a live claim about a missing file", () => {
    // The exact sentence that shipped in plane-firewall.ts for a full release.
    const shipped = "* credential shape got there, and `route-planes.test.ts` asserts a violation is\n * observable rather than trusting that it would be.";
    const [c] = citationsIn(shipped);
    expect(c?.name).toBe("route-planes.test.ts");
    expect(c?.deliberatelyAbsent).toBe(false);
    expect(realSpecNames.has(c?.name ?? "")).toBe(false);
  });
});
