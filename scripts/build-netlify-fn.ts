/**
 * Pre-bundles the Netlify Function entry so Netlify's bundler doesn't have
 * to walk our `.ts`-source workspace packages (which it can't transpile).
 *
 * - Source: `apps/web/src/server/entries/netlify-fn-entry.ts`
 * - Output: `apps/web/netlify/functions/api.mjs`
 *
 * Everything is inlined — workspace `@backlex/*` and every npm dep —
 * because Bun's monorepo `node_modules/.bun` store layout confuses
 * Netlify's nft tracer (e.g. `postgres` ends up missing from the zip
 * even though `drizzle-orm/postgres-js` imports it). A self-contained
 * single-file Function avoids the whole class of resolution issues.
 *
 * The Bun-specific `bun:sqlite` module is aliased to a throwing shim
 * so Node ESM doesn't choke on the `bun:` protocol at load time. The
 * sqlite path is never taken on Netlify anyway — we always pick
 * neon-http via `DATABASE_DRIVER`.
 */
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const SOURCE = "apps/web/src/server/entries/netlify-fn-entry.ts";
const OUTPUT_DIR = "apps/web/netlify/functions";
const SHIM_BUN_SQLITE = fileURLToPath(
  new URL("../apps/web/src/server/shims/bun-sqlite-shim.ts", import.meta.url),
);

mkdirSync(OUTPUT_DIR, { recursive: true });

const result = await Bun.build({
  entrypoints: [SOURCE],
  outdir: OUTPUT_DIR,
  naming: "api.mjs",
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
console.log(`✓ Pre-bundled Netlify function → ${OUTPUT_DIR}/api.mjs (${size} MB, ${out?.kind})`);
