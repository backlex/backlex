/**
 * The worker's startup cost, in MILLISECONDS, held to a ceiling.
 *
 * WHY THIS EXISTS
 *
 * Cloudflare rejects a deploy whose script spends too long starting up — error
 * 10021 — and on 2026-09-10 it did: PR #367's build was refused and a retrigger
 * of the SAME commit succeeded. The worker straddles the limit, so every push
 * is a coin flip. Issue #372.
 *
 * `apps/web/tests/worker-startup-budget.test.ts` already guards a budget, but
 * it counts SOURCE BYTES of the eager graph, comments included. That is not the
 * quantity CF enforces, and the two came apart completely the same day: four
 * merges moved the source figure 8465 → 8497 KiB while the thing CF measures
 * was untouched by almost all of it. Both guards are worth having — bytes catch
 * something becoming REACHABLE, milliseconds catch it becoming EXPENSIVE — but
 * only this one is measuring the failure.
 *
 * WHY THE MEDIAN OF SEVERAL RUNS
 *
 * Because one run gave the wrong answer and nearly shipped as a fix. Removing
 * the 404 KiB MCP tool registry from the eager graph measured 257 → 209 ms on
 * one run each — a 19% win — and vanished at three runs each (216.5 / 217.1 /
 * 212.7 against 209.2 / 209.2 / 225.8). The 257 was a cold-start outlier on the
 * baseline. A single sample here is not evidence.
 *
 * WHAT THE NUMBER IS MADE OF, since the two halves have opposite fixes
 * (measured with `--profile`, grouped by URL rather than by chunk name):
 *
 *   ~85 ms  V8 COMPILE (`compileSourceTextModule`) — scales with bytes
 *   ~82 ms  vendor's top-level EXECUTION — zod/drizzle/hono building and
 *           registering schemas at import, not parsing them
 *   ~46 ms  GC + program
 *    1.5 ms the entire 404 KiB tool registry — declarative modules are cheap
 *           however large, which is exactly why the byte ceiling mispredicts
 *
 * So a byte-shaving change will barely move this, and something that RUNS at
 * import will move it a lot. That is the signal the ceiling is here to catch.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "apps/web/scripts/measure-startup.mjs");
const BUNDLE = join(REPO_ROOT, "apps/web/dist/backlex_admin/index.js");

/** Odd, so the median is a real sample rather than an average of two. */
const RUNS = 5;

/**
 * Ceiling for the MEDIAN, in milliseconds.
 *
 * MEASURED BASELINES, both on record rather than guessed:
 *
 *   ~215 ms  this dev machine (M-series, node/V8)
 *    317 ms  a GitHub `ubuntu-latest` runner — 316.6 median, samples
 *            305.8 / 315.3 / 316.6 / 316.7 / 334.6, a 9% spread within one run
 *
 * 600 is 1.9x the CI baseline. **It is a compromise, and the reason is worth
 * knowing before anybody calls it arbitrary:** the regression this wants to
 * catch and the host noise it must tolerate are the same order of magnitude. A
 * big package re-entering the eager graph — better-auth (1.3 MB), the AI SDK
 * (860 KB) — adds roughly the baseline again, so ~630 ms on CI. A genuinely
 * slow runner could plausibly reach 1.5x, so ~475 ms. Those two are 150 ms
 * apart, which is not much of a gap to put a threshold in.
 *
 * So this bound is set to sit above the noise rather than snugly under the
 * regression, following #364's answer to exactly this shape: a bound generous
 * enough that only a real change trips it beats a tight one that trips on a
 * busy host. **The trend line is the better signal** — the median is printed on
 * every run and written to the CI job summary green or red, so a creep from 317
 * toward 450 is visible long before this number is reached.
 *
 * Do NOT raise this to make a red run green. Unlike the byte ceiling next door,
 * a number here going up means the deploy got closer to being refused — and by
 * the measurement in `measure-startup.mjs`'s header (CF runs 2-3x the local
 * figure), this worker is already inside the band where 10021 has been observed.
 */
const MAX_MS = 600;

/**
 * Below this the harness is not measuring the worker.
 *
 * The house rule: a guard that matches nothing reports success. If the bundle
 * were replaced by a stub, or the loader hook stopped resolving the graph, the
 * import would return in single-digit milliseconds and this check would pass
 * while checking nothing.
 */
const MIN_MS = 20;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

const measureOnce = (): number => {
  // `node`, not bun, and that is load-bearing: workerd is V8 and so is node, so
  // its compile and top-level-eval costs are the ones that transfer. See the
  // header of `measure-startup.mjs`.
  const r = spawnSync("node", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) {
    console.error(out);
    throw new Error(`measure-startup.mjs exited ${r.status}`);
  }
  const m = /compile \+ top-level\s+([\d.]+) ms/.exec(out);
  if (!m?.[1]) {
    console.error(out);
    throw new Error("could not parse a duration out of measure-startup.mjs");
  }
  return Number(m[1]);
};

const main = (): void => {
  if (!existsSync(BUNDLE)) {
    // Fail rather than skip. A skipped check reads exactly like a passing one
    // in a CI log, and this runs after `build:targets` in both places that
    // invoke it — so a missing bundle means the build did not produce what it
    // claims, which is itself the finding.
    console.error(
      `No worker bundle at ${BUNDLE}\n` +
        "Run `bun run build:targets` (or `bun run build`) first — this check reads the BUILT article.",
    );
    process.exit(1);
  }

  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) samples.push(measureOnce());
  const mid = median(samples);
  const line = `startup median ${mid.toFixed(1)} ms over ${RUNS} runs (ceiling ${MAX_MS} ms) — samples: ${samples.map((s) => s.toFixed(1)).join(", ")}`;
  console.log(line);

  // Put the number where somebody will see it without opening the log, so the
  // baseline this ceiling wants is on record after the first few runs.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `## Worker startup\n\n\`${line}\`\n`);
    } catch {
      // A summary that cannot be written must not fail the check.
    }
  }

  if (mid < MIN_MS) {
    console.error(
      `\nstartup measured ${mid.toFixed(1)} ms, below the ${MIN_MS} ms floor — the harness is not ` +
        "measuring the worker. Check that the bundle is the real one and that " +
        "`measure-startup.mjs`'s loader hook still resolves the eager graph.",
    );
    process.exit(1);
  }

  if (mid > MAX_MS) {
    console.error(
      `\nstartup median ${mid.toFixed(1)} ms exceeds the ${MAX_MS} ms ceiling.\n\n` +
        "Cloudflare refuses a deploy that spends too long starting up (error 10021), and\n" +
        "this worker already sits close enough to that line to be rejected intermittently\n" +
        "(#372). Find what grew with:\n\n" +
        "    bun run build\n" +
        "    node apps/web/scripts/measure-startup.mjs --profile\n\n" +
        "Read the profile by URL, not by chunk name. Compile time is attributed to a\n" +
        "node-internal frame and scales with bytes; a chunk's own self time is what it\n" +
        "DOES at import. Those have opposite fixes — see this file's header.",
    );
    process.exit(1);
  }
};

main();
