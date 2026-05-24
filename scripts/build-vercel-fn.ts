/**
 * Pre-bundles the Vercel Function entry so Vercel's bundler doesn't have
 * to walk our `.ts`-source workspace packages (which it can't transpile —
 * `Cannot find module entries/vercel` at Lambda runtime).
 *
 * - Source: `apps/web/src/server/entries/vercel-fn-entry.ts`
 * - Output: `api/[...all].mjs` — Vercel routes any unmatched path under
 *   `/api/*` to this catch-all function with `request.url` left intact
 *   (no rewrite path-strip). The square brackets make the filename a
 *   dynamic route segment in Vercel's filesystem routing.
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
// Output filename — Vercel's "Other Frameworks" filesystem routing
// treats filenames as literal URL segments. Catch-all syntax like
// `[...all].mjs` only works in Next.js — for everyone else, route all
// `/api/*` paths through `vercel.ts::rewrites` into this single file,
// then reconstruct the original URL inside the function (see
// `vercel-fn-entry.ts`).
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
