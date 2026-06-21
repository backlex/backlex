/**
 * Bundles the Azure Functions (v4 Node model) entry into a deployable folder:
 *
 * - Source: `apps/web/src/server/entries/azure.ts`
 * - Output: `apps/web/dist/azure/index.mjs` (+ generated `host.json` &
 *   `package.json`)
 *
 * Deploy the folder with the Azure Functions Core Tools / `az`:
 *
 *   cd apps/web/dist/azure && func azure functionapp publish <APP_NAME>
 *
 * Same Bun bundling approach as the Node/Lambda targets. Azure-specific bits:
 *   - `bun:sqlite` is aliased to its throwing shim (use Postgres / libSQL).
 *   - `@azure/functions` is left EXTERNAL and declared as a dependency in the
 *     generated `package.json`. The Azure runtime provides/loads it, and
 *     `app.http()/app.timer()` must register on THAT instance — never inline it.
 *   - `sharp`, `@libsql/client`, `@cf-wasm/photon` are left external (native
 *     addons / wasm), resolved from the deployed node_modules.
 *   - A `host.json` is emitted with `extensions.http.routePrefix: ""` so the
 *     single catch-all function also serves `/health`, `/docs`, and the SPA —
 *     not just the default `/api` prefix.
 */
import { fileURLToPath } from "node:url";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const SOURCE = "apps/web/src/server/entries/azure.ts";
const OUTPUT_DIR = "apps/web/dist/azure";
const SPA_SRC = "apps/web/dist/client";
const SHIM_BUN_SQLITE = fileURLToPath(
  new URL("../apps/web/src/server/shims/bun-sqlite-shim.ts", import.meta.url),
);

const EXTERNAL = ["@azure/functions", "sharp", "@libsql/client", "@cf-wasm/photon"];

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

// host.json — v4 model, with the route prefix cleared so the catch-all
// `{*path}` route covers every path, not only `/api/*`.
const hostJson = {
  version: "2.0",
  extensionBundle: {
    id: "Microsoft.Azure.Functions.ExtensionBundle",
    version: "[4.*, 5.0.0)",
  },
  extensions: { http: { routePrefix: "" } },
};
writeFileSync(`${OUTPUT_DIR}/host.json`, `${JSON.stringify(hostJson, null, 2)}\n`);

// Deploy manifest. `main` points the v4 model at the bundle (where the
// functions register); the framework + sharp are real deps installed on deploy.
const pkg = {
  name: "backlex-azure-function",
  type: "module",
  main: "index.mjs",
  engines: { node: ">=22" },
  dependencies: {
    "@azure/functions": "^4.0.0",
    sharp: "^0.34.0",
  },
};
writeFileSync(`${OUTPUT_DIR}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);

// Copy the pre-built admin SPA next to the bundle (entries/azure.ts mounts
// `./client` relative to the bundle). `build:targets` runs `vite build` first.
if (existsSync(SPA_SRC)) {
  cpSync(SPA_SRC, `${OUTPUT_DIR}/client`, { recursive: true });
  console.log(`✓ Copied admin SPA → ${OUTPUT_DIR}/client`);
} else {
  console.warn(
    `⚠ ${SPA_SRC} not found — run \`bun run build\` (vite) first; the admin SPA won't be served.`,
  );
}

const out = result.outputs[0];
const size = out ? (out.size / 1024 / 1024).toFixed(2) : "?";
console.log(`✓ Bundled Azure Function → ${OUTPUT_DIR}/index.mjs (${size} MB)`);
console.log("  Deploy: cd apps/web/dist/azure && func azure functionapp publish <APP_NAME>");
