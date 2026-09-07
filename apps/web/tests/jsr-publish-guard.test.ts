/**
 * The JSR publish step still fails when it publishes nothing.
 *
 * `jsr publish` does not error on a version it already holds. It prints
 * `Warning: Skipping, already published @backlex/backlex@x.y.z` and **exits 0**.
 * That is how `backlex-v0.4.0` and `backlex-v0.4.1` each fired the workflow,
 * each shipped nothing, and each reported GREEN — `jsr.json` had drifted to
 * 0.3.3 while `package.json` moved on. Run 34026227468 has it in the log.
 *
 * Two things now stand between that and a repeat, and they guard different
 * halves. `sdk-exports.test.ts` pins the two version numbers together, so the
 * DRIFT cannot happen. This pins the workflow's reaction, so the one outcome
 * meaning "nothing shipped" cannot read as success — which still matters,
 * because re-running an old tag reaches it with no drift at all.
 *
 * WHY A STRING CHECK IS THE RIGHT TOOL HERE, since normally it is not. The
 * logic is four lines of bash inside a workflow; no bun test can execute it,
 * and it was verified by hand against all three shapes of `jsr publish` output
 * (real publish → 0, skipped → 1, jsr fails → its own code). What can regress
 * is somebody tidying the step back to a one-liner, which looks like an
 * improvement and silently restores the bug. That is what this catches.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = readFileSync(
  join(import.meta.dir, "..", "..", "..", ".github", "workflows", "publish-backlex-jsr.yml"),
  "utf8",
);

describe("publish-backlex-jsr.yml", () => {
  test("the workflow still publishes to JSR at all (vacuous-pass guard)", () => {
    // Every assertion below is about the SHAPE of the publish step. If the step
    // were renamed or removed they would all have nothing to disagree with.
    expect(WORKFLOW).toContain("jsr publish");
  });

  test("a skipped upload fails the run", () => {
    expect(
      WORKFLOW.includes("Skipping, already published"),
      "The JSR publish step no longer checks for `Skipping, already published`. " +
        "Without it a run that shipped NOTHING exits 0 and reports green — the " +
        "exact failure that left JSR two releases behind npm.",
    ).toBe(true);
    expect(WORKFLOW).toMatch(/exit 1/);
  });

  test("`pipefail` is set, because `tee` otherwise swallows a real failure", () => {
    // Measured, not assumed: `bash -e -c 'false | tee log'` exits 0. So piping
    // jsr's output through `tee` WITHOUT pipefail would make every genuine
    // publish failure green — introducing the same class of bug the check above
    // exists to remove.
    expect(
      WORKFLOW.includes("set -o pipefail"),
      "The publish step pipes `jsr publish` into `tee` but no longer sets " +
        "pipefail. GitHub's default shell is `bash -e`, which takes tee's exit " +
        "status — so a failed publish would report success.",
    ).toBe(true);
  });
});
