/**
 * Bundles the AWS Lambda entry into a single deployable file:
 *
 * - Source: `apps/web/src/server/entries/lambda.ts`
 * - Output: `apps/web/dist/lambda/index.mjs`
 *
 * The Lambda handler string is then `index.handler` (buffered: API Gateway /
 * ALB / default Function URL) or `index.streamHandler` (response-streaming
 * Function URL). Zip `dist/lambda/` (plus any external native addons, see
 * below) and upload, or point a container/`AWS::Serverless::Function` at it.
 *
 * Same approach as the Vercel/Netlify/Node pre-bundles: Bun inlines the
 * `.ts`-source workspace packages (`@backlex/*`) and npm deps into one
 * self-contained ESM file. Lambda-specific bits:
 *   - `bun:sqlite` is aliased to its throwing shim — the `bun:` specifier can't
 *     be parsed off-Bun, and the sqlite path is never taken on Lambda anyway
 *     (use `DATABASE_URL` → Postgres, or libSQL/Turso).
 *   - `sharp`, `@libsql/client`, and `@cf-wasm/photon` are left external —
 *     native addons / wasm that can't be inlined. To use them on Lambda, ship
 *     the matching `node_modules` entry inside the deployment zip (built for
 *     `linux-x64`/`linux-arm64` to match the function architecture) or attach a
 *     Lambda layer. Without `sharp` present, image transforms degrade to
 *     passthrough — everything else works.
 *   - `@hono/node-server` is NOT used here (no long-running HTTP server); the
 *     Hono `aws-lambda` adapter maps the Lambda event ↔ `Request`/`Response`.
 */
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const SOURCE = "apps/web/src/server/entries/lambda.ts";
const OUTPUT_DIR = "apps/web/dist/lambda";
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
  // Native addons / wasm — resolved at runtime from node_modules (or a layer),
  // not inlined. Mirror `scripts/build-node.ts`.
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
console.log(`✓ Bundled AWS Lambda function → ${OUTPUT_DIR}/index.mjs (${size} MB)`);
console.log("  Handler (buffered):  index.handler   — API Gateway / ALB / Function URL");
console.log("  Handler (streaming): index.streamHandler — Function URL (RESPONSE_STREAM)");
