/**
 * Bundles the Google Cloud Functions (2nd gen) entry into a deployable folder:
 *
 * - Source: `apps/web/src/server/entries/gcp.ts`
 * - Output: `apps/web/dist/gcp/index.mjs`  (+ a generated `package.json`)
 *
 * Deploy the folder with `--entry-point=api`:
 *
 *   gcloud functions deploy backlex \
 *     --gen2 --runtime=nodejs22 --entry-point=api --trigger-http \
 *     --source=apps/web/dist/gcp --allow-unauthenticated
 *
 * Same Bun bundling approach as the Node/Lambda targets. GCF-specific bits:
 *   - `bun:sqlite` is aliased to its throwing shim (the `bun:` specifier can't
 *     be parsed off-Bun; use Postgres / libSQL on GCF).
 *   - `@google-cloud/functions-framework` is left EXTERNAL and declared as a
 *     dependency in the generated `package.json`. The GCF buildpack installs
 *     and runs it; `http("api", …)` must register on THAT instance, so it must
 *     not be inlined into the bundle.
 *   - `sharp`, `@libsql/client`, `@cf-wasm/photon` are left external (native
 *     addons / wasm) — the buildpack's `npm install` resolves them from the
 *     generated `package.json` for the deploy platform.
 */
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const SOURCE = "apps/web/src/server/entries/gcp.ts";
const OUTPUT_DIR = "apps/web/dist/gcp";
const SHIM_BUN_SQLITE = fileURLToPath(
  new URL("../apps/web/src/server/shims/bun-sqlite-shim.ts", import.meta.url),
);

// Native / wasm addons + the function framework: resolved at runtime from the
// deployed node_modules, never inlined.
const EXTERNAL = [
  "@google-cloud/functions-framework",
  "sharp",
  "@libsql/client",
  "@cf-wasm/photon",
];

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
  external: EXTERNAL,
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

// Deploy manifest. `main` makes the buildpack load index.mjs (where `http()`
// registers the `api` entry-point); the framework + native addons are real
// deps so `npm install` pulls them on the platform.
const pkg = {
  name: "backlex-gcp-function",
  type: "module",
  main: "index.mjs",
  engines: { node: ">=22" },
  dependencies: {
    "@google-cloud/functions-framework": "^5.0.0",
    sharp: "^0.34.0",
  },
};
writeFileSync(`${OUTPUT_DIR}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);

const out = result.outputs[0];
const size = out ? (out.size / 1024 / 1024).toFixed(2) : "?";
console.log(`✓ Bundled Google Cloud Function → ${OUTPUT_DIR}/index.mjs (${size} MB)`);
console.log("  Deploy: gcloud functions deploy backlex --gen2 --runtime=nodejs22 \\");
console.log("            --entry-point=api --trigger-http --source=apps/web/dist/gcp");
