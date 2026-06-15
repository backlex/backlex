/**
 * Bundles the standalone Node.js self-host entry into a single runnable file:
 *
 * - Source: `apps/web/src/server/entries/node.ts`
 * - Output: `apps/web/dist/node/server.mjs`  → run with `node server.mjs`
 *
 * Same approach as the Vercel/Netlify pre-bundles: Bun inlines the `.ts`-source
 * workspace packages (`@backlex/*`) and npm deps into one self-contained ESM
 * file. Two runtime specifics for Node:
 *   - `bun:sqlite` is aliased to its throwing shim — the `bun:` specifier can't
 *     be parsed by Node's ESM loader, and the sqlite path is never taken on
 *     Node anyway (use `DATABASE_URL` → Postgres, or libSQL).
 *   - `sharp` is left external — it's a native addon that can't be inlined; it
 *     resolves from `node_modules` at runtime (image transforms on Node).
 */
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const SOURCE = "apps/web/src/server/entries/node.ts";
const OUTPUT_DIR = "apps/web/dist/node";
const SHIM_BUN_SQLITE = fileURLToPath(
  new URL("../apps/web/src/server/shims/bun-sqlite-shim.ts", import.meta.url),
);

mkdirSync(OUTPUT_DIR, { recursive: true });

const result = await Bun.build({
  entrypoints: [SOURCE],
  outdir: OUTPUT_DIR,
  naming: "server.mjs",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "none",
  minify: false,
  // Native addons — resolved from node_modules at runtime, not inlined.
  // `@libsql/client` loads a per-platform native binding (`@libsql/<platform>`)
  // for `file:`/`:memory:` SQLite; keep it external so that require resolves.
  external: ["sharp", "@libsql/client", "@cf-wasm/photon"],
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
console.log(`✓ Bundled standalone Node server → ${OUTPUT_DIR}/server.mjs (${size} MB)`);
console.log("  Run: DATABASE_URL=postgres://… AUTH_SECRET=… node apps/web/dist/node/server.mjs");
