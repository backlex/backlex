/**
 * Bundles the Deno self-host entry into a single runnable file:
 *
 * - Source: `apps/web/src/server/entries/deno.ts`
 * - Output: `apps/web/dist/deno/server.mjs`  → run with
 *   `deno run --allow-all apps/web/dist/deno/server.mjs`
 *
 * Same approach as the standalone Node pre-bundle: Bun inlines the
 * `.ts`-source workspace packages (`@backlex/*`) and npm deps into one
 * self-contained ESM file so Deno never has to resolve the monorepo's
 * `node_modules/.bun` store. Runtime specifics for Deno:
 *   - `bun:sqlite` is aliased to its throwing shim — the `bun:` specifier
 *     can't be parsed by Deno's loader, and the sqlite path is never taken
 *     on Deno anyway (use `DATABASE_URL` → Postgres, or `LIBSQL_URL`).
 *   - `sharp` is left external — a native addon that can't be inlined; on
 *     Deno it typically won't load at all, so the image adapter degrades to
 *     passthrough (see the deno.ts entry header).
 *   - `@libsql/client` is left external — it loads a per-platform native
 *     binding (`@libsql/<platform>`) for `file:`/`:memory:` SQLite; Deno
 *     resolves it from `node_modules` at runtime (npm-compat / byonm).
 */
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { builtinModules } from "node:module";

const SOURCE = "apps/web/src/server/entries/deno.ts";
const OUTPUT_DIR = "apps/web/dist/deno";
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

// Deno only resolves Node builtins through the `node:` prefix, but Bun's
// bundler auto-externalizes builtins BEFORE plugins run and leaves the bare
// specifiers from npm deps (`import net from "net"`, `require("fs")`) as-is —
// an onResolve plugin never sees them. Post-process the emitted bundle:
// rewrite every bare-builtin import/require specifier to its `node:` form.
const BUNDLE_PATH = `${OUTPUT_DIR}/server.mjs`;
const bareBuiltins = builtinModules
  .filter((m) => !m.startsWith("node:"))
  .map((m) => m.replaceAll("/", "\\/"))
  .join("|");
// Matches `from "fs"`, `import "fs"`, `import("fs")`, `require("fs")` —
// quote-delimited so unrelated string literals are never touched.
const bareImportRe = new RegExp(
  `(\\b(?:from|import|require)\\s*\\(?\\s*)(["'])(${bareBuiltins})\\2`,
  "g",
);
const code = await Bun.file(BUNDLE_PATH).text();
await Bun.write(
  BUNDLE_PATH,
  code.replace(bareImportRe, (_m, pre, q, mod) => `${pre}${q}node:${mod}${q}`),
);

const out = result.outputs[0];
const size = out ? (out.size / 1024 / 1024).toFixed(2) : "?";
console.log(`✓ Bundled Deno server → ${OUTPUT_DIR}/server.mjs (${size} MB)`);
console.log(
  "  Run: DATABASE_URL=postgres://… AUTH_SECRET=… deno run --allow-all apps/web/dist/deno/server.mjs",
);
