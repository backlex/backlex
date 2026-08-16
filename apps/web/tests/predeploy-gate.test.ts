/**
 * The pre-deploy gate, and the two ways it can quietly stop being one.
 *
 * **What it is for.** Cloudflare Workers Builds deploys on push to `main` and
 * `test.yml` runs on push to `main`, and neither waits for the other — so the
 * deploy that ships a broken commit finishes while its own tests are still
 * running. The suite is a tripwire, not a gate.
 *
 * **Why it cannot simply be made to wait**, which is the fact that shaped
 * everything: the `test` job takes ~16 minutes and Cloudflare terminates a
 * build at 20. A build that waited for the suite would be killed before doing
 * its own work. So the real fix inverts the trigger (the `deploy` job below),
 * and `scripts/require-green-checks.ts` is the cheap half that refuses a commit
 * already known to be red.
 *
 * These are source assertions on purpose. There is no input that makes a
 * drifted `paths-ignore` list or a deleted `needs:` visible at run time — the
 * gate would simply stop gating, silently, which is the failure it exists to
 * prevent in the first place.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/test.yml"), "utf8");
const SCRIPT = readFileSync(resolve(ROOT, "scripts/require-green-checks.ts"), "utf8");
const ROOT_PKG = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("pre-deploy gate", () => {
  test("the gate runs before the build the Cloudflare dashboard invokes", () => {
    // The build and deploy commands for this Worker live in the Cloudflare
    // dashboard, not in this repo — so `bun run build` is the only hook the
    // repo controls, and the gate has to be the first thing in it.
    const build = ROOT_PKG.scripts.build ?? "";
    expect(build).toContain("scripts/require-green-checks.ts");
    expect(build.indexOf("require-green-checks")).toBeLessThan(
      build.indexOf("--cwd apps/web build"),
    );
  });

  test("the script's ignore list matches the workflow's paths-ignore", () => {
    // The drift that would break it: `test.yml` skips docs-only pushes, so no
    // run is ever created for them. The script re-implements that list to tell
    // "no run was owed" apart from "the run is missing". If the two fall out of
    // step, a docs push either blocks the deploy or an untested code path slips
    // through — opposite failures from one cause.
    const block = WORKFLOW.match(/paths-ignore:\n((?:\s+- "[^"]+"\n)+)/);
    expect(block?.[1]).toBeTruthy();
    const workflowIgnores = [...block![1]!.matchAll(/- "([^"]+)"/g)].map((m) => m[1]!);
    expect(workflowIgnores.length).toBeGreaterThan(0);

    // Every workflow pattern must be represented in the script. Compared by
    // meaning, not by string: the workflow speaks globs and the script speaks
    // regexes, so a sample path per glob is the honest comparison.
    const samples: Record<string, string> = {
      "**.md": "README.md",
      "docs/**": "docs/jobs.md",
      "apps/docs/**": "apps/docs/astro.config.mjs",
      LICENSE: "LICENSE",
    };
    const rxSource = SCRIPT.match(/const IGNORED_PATH_PATTERNS = \[([^\]]+)\]/)?.[1];
    expect(rxSource).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const patterns = new Function(`return [${rxSource}]`)() as RegExp[];

    for (const glob of workflowIgnores) {
      const sample = samples[glob];
      expect({ glob, known: sample !== undefined }).toEqual({ glob, known: true });
      expect({ glob, ignored: patterns.some((rx) => rx.test(sample!)) }).toEqual({
        glob,
        ignored: true,
      });
    }

    // And the reverse: a path the workflow tests must NOT be treated as ignorable.
    for (const tested of ["apps/web/src/server/app.ts", "packages/db/src/pg/schema.ts"]) {
      expect({ tested, ignored: patterns.some((rx) => rx.test(tested)) }).toEqual({
        tested,
        ignored: false,
      });
    }
  });

  test("the deploy job waits on every job that ran, not merely on `always()`", () => {
    const deploy = WORKFLOW.slice(WORKFLOW.indexOf("\n  deploy:"));
    expect(deploy).toContain("needs: [test, changes, build, runtime-smoke]");
    // `always()` alone would deploy on a RED test — it means "run even if a
    // dependency was skipped", not "run only if nothing failed". The explicit
    // result checks are what make this a gate; losing them is the whole bug.
    expect(deploy).toContain("always()");
    expect(deploy).toContain("needs.test.result == 'success'");
    expect(deploy).toContain("needs['runtime-smoke'].result != 'failure'");
    // Hyphenated job names cannot be read with dot notation in an Actions
    // expression — `needs.runtime-smoke.result` silently evaluates to nothing,
    // and a condition that quietly becomes `!= 'failure'` on `null` passes.
    expect(deploy).not.toMatch(/needs\.runtime-smoke\./);
    // Main only, and only on a real push.
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain("github.event_name == 'push'");
  });

  test("the deploy job is inert, not broken, until its secrets exist", () => {
    const deploy = WORKFLOW.slice(WORKFLOW.indexOf("\n  deploy:"));
    // It ships disabled: nobody has created the Cloudflare token yet, and a job
    // that failed every run until they did would just be turned off.
    expect(deploy).toContain("CF_BUILD_TRIGGER_UUID");
    expect(deploy).toMatch(/if \[ -z "\$CF_API_TOKEN" \]/);
    expect(deploy).toContain("::notice::");
    // But a trigger that IS configured and fails must fail the job — a deploy
    // that silently did not happen is worse than one that did not happen loudly.
    expect(deploy).toMatch(/\[ "\$code" -ge 200 \] && \[ "\$code" -lt 300 \]/);
  });

  test("the script blocks a known-failed run in both modes, and says why", () => {
    // The one behaviour that must never become advisory.
    expect(SCRIPT).toContain('run.conclusion === "success"');
    expect(SCRIPT).toContain("Refusing to build");
    // `cancelled` is not a pass: test.yml cancels superseded runs, and a
    // superseded run proves nothing about this commit.
    expect(SCRIPT).toContain("cancelled");
    // A gate that cannot reach GitHub must not become a gate that lets
    // everything through.
    expect(SCRIPT).toMatch(/main\(\)\.catch[\s\S]{0,400}process\.exit\(1\)/);
  });

  test("strict mode's wait stays far below Cloudflare's build ceiling", () => {
    // The measurement that killed the obvious design: the suite takes ~16
    // minutes, a Cloudflare build is terminated at 20. Any default wait near
    // that ceiling turns the gate into the thing that kills the build.
    const ms = Number(SCRIPT.match(/PREDEPLOY_GATE_TIMEOUT_MS \?\? ([\d_]+)/)?.[1]?.replace(/_/g, ""));
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});
