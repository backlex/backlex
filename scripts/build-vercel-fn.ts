/**
 * Pre-bundles the Vercel Function entry so Vercel's bundler doesn't have
 * to walk our `.ts`-source workspace packages (which it can't transpile —
 * `Cannot find module entries/vercel` at Lambda runtime).
 *
 * - Source: `apps/web/src/server/entries/vercel-fn-entry.ts`
 * - Output: `api/index.mjs` (Vercel picks this up automatically as
 *   the `/api/index` function referenced by `vercel.json` rewrites)
 *
 * Mirrors `scripts/build-netlify-fn.ts`. Everything is inlined —
 * workspace `@workeros/*` and every npm dep — because Bun's monorepo
 * `node_modules/.bun` store layout confuses the Vercel build's
 * dep tracer too. `bun:sqlite` is aliased to its shim so Node ESM
 * doesn't choke on the `bun:` protocol at load time.
 */
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const SOURCE = "apps/web/src/server/entries/vercel-fn-entry.ts";
const OUTPUT_DIR = "api";
const SHIM_BUN_SQLITE = fileURLToPath(
  new URL("../apps/web/src/server/shims/bun-sqlite-shim.ts", import.meta.url),
);

mkdirSync(OUTPUT_DIR, { recursive: true });

const result = await Bun.build({
  entrypoints: [SOURCE],
  outdir: OUTPUT_DIR,
  naming: "index.mjs",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "none",
  minify: false,
  plugins: [
    {
      name: "bun-sqlite-shim",
      setup(builder) {
        builder.onResolve({ filter: /^bun:sqlite$/ }, () => ({
          path: SHIM_BUN_SQLITE,
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const out = result.outputs[0];
const size = out ? (out.size / 1024 / 1024).toFixed(2) : "?";
console.log(`✓ Pre-bundled Vercel function → ${OUTPUT_DIR}/index.mjs (${size} MB)`);
