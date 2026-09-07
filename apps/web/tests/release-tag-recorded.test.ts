/**
 * A release that was TAGGED but never `surface:record`ed is caught.
 *
 * The release runbook is bump → tag → record, and recording *after* the tag is
 * deliberate: recording at bump time would make `live === recorded`, the drift
 * tests would return early, and the owed release would stop being visible —
 * the one thing they exist to show. The cost of that ordering is a window
 * (bump → tag → record) in which those guards are inert.
 *
 * **That window was skipped exactly once in four releases, and once was
 * enough.** `backlex-v0.4.0` shipped and nobody recorded; with `package.json`
 * at 0.4.1 and the baseline stamped 0.3.3, the drift test's
 * `pkg.version !== recorded.version` assertion was satisfied by a TWO-RELEASE
 * GAP — so the surface check could not fail no matter what moved. See #336.
 *
 * Tags are the only evidence CI has that a release shipped: they are repo
 * state, where npm is a network CI cannot reach by design.
 *
 * The trap this file is mostly about: `actions/checkout` fetches no tags. A
 * naive version of this check would find an empty list, compare nothing, and
 * report SUCCESS — a permanently green check guarding nothing, which is worse
 * than no check at all. So an empty tag list is a FAILURE here, not a skip, and
 * `.github/workflows/test.yml` carries an explicit `git fetch` of the tag refs
 * that keeps it answerable. Break-verified in both directions: a stale
 * `recorded.version` goes red, and so does a checkout with no tags.
 *
 * That guard EARNED ITS KEEP on the very first CI run. `fetch-tags: true` on
 * the checkout step looked sufficient and is not — it does not populate tags
 * alongside the default `fetch-depth: 1` — so this file went red on PR #346
 * while passing locally. Which is the point: without the empty-list assertion
 * the job would have gone green over a check comparing nothing, and nobody
 * would have learned that for another four releases.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../..");

/** Every tag matching `<prefix>v<semver>`, newest version first. */
const tagsFor = (prefix: string): string[] => {
  const out = Bun.spawnSync(["git", "tag", "--list", `${prefix}v*`], { cwd: REPO });
  if (out.exitCode !== 0) return [];
  return out.stdout
    .toString()
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => new RegExp(`^${prefix}v\\d+\\.\\d+\\.\\d+$`).test(t));
};

const parse = (v: string): [number, number, number] => {
  const [a, b, c] = v.split(".").map(Number);
  return [a ?? 0, b ?? 0, c ?? 0];
};

/** -1 / 0 / 1 */
const cmp = (a: string, b: string): number => {
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM) return aM < bM ? -1 : 1;
  if (am !== bm) return am < bm ? -1 : 1;
  if (ap !== bp) return ap < bp ? -1 : 1;
  return 0;
};

const newest = (versions: string[]): string =>
  versions.reduce((best, v) => (cmp(v, best) > 0 ? v : best), "0.0.0");

interface Target {
  label: string;
  /** Tag prefix, e.g. `backlex-`. */
  prefix: string;
  /** Where the recorded baseline lives, relative to the repo root. */
  surface: string;
  /** The command that restates the baseline. */
  record: string;
}

const TARGETS: Target[] = [
  {
    label: "SDK",
    prefix: "backlex-",
    surface: "packages/client/published-surface.json",
    record: "bun run --cwd packages/client surface:record",
  },
  {
    label: "CLI",
    prefix: "cli-",
    surface: "packages/cli/published-surface.json",
    record: "bun run --cwd packages/cli surface:record",
  },
];

describe("a tagged release is reflected in the recorded surface", () => {
  test("tags are visible at all (the check cannot answer without them)", () => {
    // THE vacuous-pass guard, and the reason this file exists rather than a
    // one-line comparison. Without `fetch-tags: true` on the checkout step this
    // list is empty, every comparison below compares nothing, and the job goes
    // green while guarding nothing.
    const all = TARGETS.flatMap((t) => tagsFor(t.prefix));
    expect(
      all.length,
      "No release tags are visible to git. On CI that means the checkout step " +
        "lost its `git fetch` of the tag refs, which would make every " +
        "assertion below pass by comparing an empty list — the exact shape of a " +
        "guard that reports SUCCESS while checking nothing. Restore it in " +
        ".github/workflows/test.yml. Locally, `git fetch --tags`.",
    ).toBeGreaterThan(0);
  });

  for (const t of TARGETS) {
    test(`${t.label}: the newest ${t.prefix}v* tag is not ahead of the recorded baseline`, () => {
      const tags = tagsFor(t.prefix);
      // Per-target, so one target losing its tags cannot be hidden by the other
      // still having some.
      expect(tags.length, `no ${t.prefix}v* tags visible`).toBeGreaterThan(0);

      const newestTag = newest(tags.map((tag) => tag.slice(t.prefix.length + 1)));
      const recorded = JSON.parse(
        readFileSync(join(REPO, t.surface), "utf8"),
      ) as { version: string };

      expect(
        cmp(newestTag, recorded.version) <= 0,
        `${t.prefix}v${newestTag} was tagged, but ${t.surface} still records ` +
          `${recorded.version}. A release shipped and \`surface:record\` was skipped, ` +
          "which leaves the drift guard inert: it only asks that `package.json` differ " +
          "from the baseline, and a two-release gap satisfies that while hiding every " +
          `surface change. Run \`${t.record}\` and commit the result. ` +
          "(This is what happened at backlex-v0.4.0 — see #336.)",
      ).toBe(true);
    });
  }

  test("the baselines are real versions, not placeholders", () => {
    // A baseline that drifted to "0.0.0" would satisfy every comparison above
    // by being behind everything — no, ahead of nothing. Pin the shape.
    for (const t of TARGETS) {
      const recorded = JSON.parse(
        readFileSync(join(REPO, t.surface), "utf8"),
      ) as { version: string };
      expect(/^\d+\.\d+\.\d+$/.test(recorded.version), `${t.surface} version`).toBe(true);
      expect(cmp(recorded.version, "0.0.0"), `${t.surface} is a placeholder`).toBeGreaterThan(0);
    }
  });
});
