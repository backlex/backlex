/**
 * Verifies that the same source tree builds cleanly for all four deploy
 * targets (Bun, Cloudflare Workers, Vercel, Netlify). Run before push to
 * catch edge-only regressions — a missing shim, a fresh node:net import,
 * or a Bun-specific API leaking into the worker bundle — that the
 * SQLite-in-process test suite can't see.
 *
 * Flow:
 *   1. `vite build` once (SPA bundle is identical across targets; CF
 *      dry-run + Vercel output both consume `apps/web/dist/client`).
 *   2. Three platform builds run in parallel — they write to different
 *      paths so there's no contention:
 *        - CF:      `wrangler deploy --dry-run` against `apps/web` →
 *                   bundles the worker entry, validates wrangler.toml.
 *                   No API token needed.
 *        - Vercel:  `bun scripts/build-vercel-output.ts` → emits the
 *                   Build Output API tree at `.vercel/output/`.
 *        - Netlify: `bun scripts/build-netlify-fn.ts` → pre-bundles the
 *                   function into `apps/web/netlify/functions/api.mjs`.
 *
 * Bun has no build step (single source file consumed at runtime via
 * `bun run`), so it's implicitly covered by the typecheck pass that
 * runs alongside this script in pre-push.
 *
 * Exit code: 0 if every target builds, 1 if any target fails. Each
 * target's stdout/stderr is captured and printed under a header so a
 * single failing build is easy to find in the combined output.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BuildResult {
  name: string;
  ok: boolean;
  durationMs: number;
  output: string;
}

const runStep = (
  name: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<BuildResult> =>
  new Promise((resolveStep) => {
    const start = Date.now();
    const chunks: string[] = [];
    const child = spawn(command, args, { cwd, env: process.env });
    child.stdout?.on("data", (b: Buffer) => chunks.push(b.toString()));
    child.stderr?.on("data", (b: Buffer) => chunks.push(b.toString()));
    child.on("close", (code) => {
      resolveStep({
        name,
        ok: code === 0,
        durationMs: Date.now() - start,
        output: chunks.join(""),
      });
    });
  });

const printResult = (r: BuildResult): void => {
  const status = r.ok ? "✓" : "✗";
  const secs = (r.durationMs / 1000).toFixed(1);
  console.log(`\n--- ${status} ${r.name} (${secs}s) ---`);
  if (!r.ok) console.log(r.output);
};

const main = async (): Promise<void> => {
  // 1. SPA build (sequential — CF + Vercel consume dist/client).
  console.log("→ vite build (shared SPA bundle)");
  const vite = await runStep(
    "vite build",
    "bun",
    ["run", "--cwd", "apps/web", "build"],
    REPO_ROOT,
  );
  printResult(vite);
  if (!vite.ok) {
    console.error("\nSPA build failed; aborting target builds.");
    process.exit(1);
  }

  // 2. Three platform builds in parallel.
  console.log("\n→ platform builds (parallel: cloudflare, vercel, netlify)");
  const results = await Promise.all([
    runStep(
      "cloudflare (wrangler dry-run)",
      "bunx",
      ["wrangler", "deploy", "--dry-run", "--outdir", ".tmp/cf-build"],
      resolve(REPO_ROOT, "apps/web"),
    ),
    runStep(
      "vercel (build-output-api)",
      "bun",
      ["scripts/build-vercel-output.ts"],
      REPO_ROOT,
    ),
    runStep(
      "netlify (function bundle)",
      "bun",
      ["scripts/build-netlify-fn.ts"],
      REPO_ROOT,
    ),
  ]);

  for (const r of results) printResult(r);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n✗ ${failed.length} target(s) failed.`);
    process.exit(1);
  }
  console.log("\n✓ All targets built.");
};

await main();
