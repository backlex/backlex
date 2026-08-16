/**
 * Refuse to build a commit whose tests are known to have failed.
 *
 * **The problem.** `test.yml` runs on every push to `main`, and Cloudflare
 * Workers Builds deploys on every push to `main` — *at the same time*. Neither
 * waits for the other, so the deploy that ships a broken commit finishes while
 * its own test run is still going, and the red X arrives after the bad bundle
 * is live. The suite is a tripwire, not a gate: it says what happened, which is
 * a different job from stopping it.
 *
 * **Why this script cannot simply wait, which was the obvious first design.**
 * Measured, not assumed: the `test` job takes **~16 minutes** on `main` (lint +
 * typecheck + suite + examples), and Cloudflare terminates a build at **20**.
 * A build that spent sixteen minutes waiting would have four left to do its own
 * work and would be killed on any slow run. Blocking inside the build is
 * structurally impossible here, and no amount of tuning fixes it.
 *
 * **So this is half of the answer, and the cheap half.** It cannot make the
 * deploy wait, but it can stop one that is already known to be wrong — a
 * re-run, a superseded build, a manual trigger on a commit whose tests went red
 * ten minutes ago. The other half is `.github/workflows/test.yml`'s deploy job,
 * which triggers the Cloudflare build **after** the suite passes; once that is
 * wired and the automatic branch trigger is off, every build starts life on a
 * green commit and this script confirms it in one API call.
 *
 * **Two modes, and the default is the safe-to-adopt one:**
 *
 *   - default — a *known-failed* run blocks the build; a run still in progress
 *     warns and proceeds. Strictly better than today (a red commit stops) and
 *     never worse (an unfinished one behaves exactly as it does now).
 *   - `PREDEPLOY_GATE_STRICT=1` — an unfinished run also blocks. Correct only
 *     once builds are triggered after the suite, because otherwise it blocks
 *     every push. Turn it on with the deploy job, not before.
 *
 * **It is inert everywhere else.** A developer running `bun run build`, and CI
 * running `build:targets`, see a no-op: the gate only engages when it can
 * identify the commit a CI system is building.
 *
 * Escape hatch for an emergency deploy: `SKIP_PREDEPLOY_GATE=1`, which prints a
 * loud line naming the commit so the bypass is in the build log.
 */

/** Where the commit SHA comes from, in the order we trust it.
 *
 *  `WORKERS_CI_COMMIT_SHA` is Cloudflare's documented variable (Workers Builds
 *  injects `CI`, `WORKERS_CI`, `WORKERS_CI_BUILD_UUID`, `WORKERS_CI_COMMIT_SHA`
 *  and `WORKERS_CI_BRANCH`). The Pages names follow because the two products
 *  share a runner lineage, and a gate that silently no-ops because a variable
 *  was renamed is worse than no gate. `GITHUB_SHA` last so an Actions job can
 *  reuse this script. */
const SHA_VARS = [
  "WORKERS_CI_COMMIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "CI_COMMIT_SHA",
  "GITHUB_SHA",
] as const;

/** Mirrors `paths-ignore` in `.github/workflows/test.yml`. Pinned against the
 *  real workflow by `apps/web/tests/predeploy-gate.test.ts` — the failure mode
 *  otherwise is a docs-only push that this script decides is missing a run. */
const IGNORED_PATH_PATTERNS = [/\.md$/i, /^docs\//, /^apps\/docs\//, /^LICENSE$/];

const REPO = process.env.PREDEPLOY_GATE_REPO ?? "backlex/backlex";
const WORKFLOW_PATH = ".github/workflows/test.yml";
const STRICT = process.env.PREDEPLOY_GATE_STRICT === "1";
/** Only used in strict mode, and deliberately far below Cloudflare's 20-minute
 *  build ceiling: in strict mode the run is expected to be finished already, so
 *  this is slack for API propagation, not for the suite. */
const STRICT_WAIT_MS = Number(process.env.PREDEPLOY_GATE_TIMEOUT_MS ?? 120_000);
const POLL_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const commitSha = (): string | null => {
  for (const v of SHA_VARS) {
    const value = process.env[v]?.trim();
    if (value && /^[0-9a-f]{7,40}$/i.test(value)) return value;
  }
  return null;
};

interface WorkflowRun {
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

const gh = async <T>(path: string): Promise<T> => {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "backlex-predeploy-gate",
  };
  // Optional: a token raises the rate limit from 60/hour to 5000. The repo is
  // public, so unauthenticated genuinely works — but several deploys in one
  // hour, each polling, can reach 60.
  const token = process.env.PREDEPLOY_GATE_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(
      `GitHub API refused the request (${res.status}, rate-limit remaining ${remaining ?? "?"}). ` +
        "Set PREDEPLOY_GATE_TOKEN in the Cloudflare build environment to raise the limit from 60/hour to 5000.",
    );
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return (await res.json()) as T;
};

/**
 * Did this commit change anything `test.yml` cares about?
 *
 * `test.yml` carries `paths-ignore`, so a docs-only push produces NO run at
 * all. Without this, "no run" and "run missing" would be the same observation,
 * and the gate would flag exactly the pushes that cannot break anything.
 */
const changedSomethingTested = async (sha: string): Promise<boolean> => {
  const commit = await gh<{ files?: { filename: string }[] }>(`/repos/${REPO}/commits/${sha}`);
  const files = commit.files ?? [];
  // A commit whose file list GitHub did not return (a merge over 300 files) is
  // treated as relevant. Guessing "harmless" about a commit we cannot see is
  // the wrong direction for a gate.
  if (files.length === 0) return true;
  return files.some((f) => !IGNORED_PATH_PATTERNS.some((rx) => rx.test(f.filename)));
};

const findTestRun = async (sha: string): Promise<WorkflowRun | null> => {
  const body = await gh<{ workflow_runs?: WorkflowRun[] }>(
    `/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=30`,
  );
  return (body.workflow_runs ?? []).find((r) => r.path === WORKFLOW_PATH) ?? null;
};

const short = (sha: string) => sha.slice(0, 8);

const main = async (): Promise<void> => {
  const sha = commitSha();
  if (!sha) {
    // Not a CI build — a laptop, or a job that builds without deploying. Said
    // out loud so a genuinely broken variable is visible in the log rather than
    // looking like a pass.
    console.log("[predeploy-gate] no CI commit SHA in the environment — skipping (local build)");
    return;
  }
  if (process.env.SKIP_PREDEPLOY_GATE === "1") {
    console.warn(
      `[predeploy-gate] BYPASSED for ${short(sha)} via SKIP_PREDEPLOY_GATE=1 — deploying WITHOUT a green test run.`,
    );
    return;
  }

  const deadline = Date.now() + STRICT_WAIT_MS;
  for (;;) {
    const run = await findTestRun(sha);

    if (run?.status === "completed") {
      if (run.conclusion === "success") {
        console.log(`[predeploy-gate] ✓ ${short(sha)} passed — ${run.html_url}`);
        return;
      }
      // `cancelled` counts as not-passed on purpose: test.yml's concurrency
      // group cancels superseded runs, and a superseded run proves nothing
      // about this commit. This branch blocks in BOTH modes — it is the whole
      // reason the script exists.
      console.error(
        `[predeploy-gate] ✗ ${short(sha)} — the test workflow finished "${run.conclusion}". Refusing to build.\n` +
          `    ${run.html_url}`,
      );
      process.exit(1);
    }

    if (!run && !(await changedSomethingTested(sha))) {
      console.log(
        `[predeploy-gate] ✓ ${short(sha)} changed only paths test.yml ignores — no run was owed`,
      );
      return;
    }

    const state = run ? run.status : "not started";
    if (!STRICT) {
      // The default. Cannot wait — the suite takes ~16 minutes and Cloudflare
      // kills a build at 20 — so this reports and stands aside. Once builds are
      // triggered AFTER the suite (see test.yml's deploy job), turn on
      // PREDEPLOY_GATE_STRICT=1 and this becomes a refusal.
      console.warn(
        `[predeploy-gate] ⚠ ${short(sha)} is deploying with its test run ${state}.\n` +
          "    Nothing has failed — but nothing has passed either. Wire the deploy job in test.yml\n" +
          "    and set PREDEPLOY_GATE_STRICT=1 to make this a refusal.",
      );
      return;
    }

    if (Date.now() >= deadline) {
      console.error(
        `[predeploy-gate] ✗ ${short(sha)} — its test run is ${state} after ${Math.round(
          STRICT_WAIT_MS / 1000,
        )}s and strict mode is on. Refusing to build an unverified commit.\n` +
          "    In strict mode the build is expected to be triggered by the suite, not alongside it.",
      );
      process.exit(1);
    }
    console.log(`[predeploy-gate] ${short(sha)} run is ${state} — re-checking`);
    await sleep(POLL_MS);
  }
};

main().catch((e) => {
  // A gate that cannot reach GitHub must not become a gate that lets anything
  // through. The message names the fix; the exit code stops the build.
  console.error(`[predeploy-gate] ✗ could not verify the commit: ${(e as Error).message}`);
  process.exit(1);
});
