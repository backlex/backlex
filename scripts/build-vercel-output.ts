/**
 * Emit the full Vercel Build Output API v3 structure ourselves, instead
 * of relying on Vercel's zero-config function discovery.
 *
 * Why: zero-config scans `api/` for handlers BEFORE `buildCommand` runs,
 * so anything we generate at build time isn't registered as a Function
 * (production 404s on every /api/* path even when the bundle ships in
 * the deploy zip). Explicit `functions: { 'api/index.mjs': {...} }` in
 * `vercel.ts` doesn't help either — the same pre-build validation fires
 * and fails the deploy with "pattern doesn't match any Serverless
 * Functions inside the api directory".
 *
 * The Build Output API takes precedence: when `.vercel/output/` exists
 * after the build step, Vercel uses it verbatim and skips its own
 * discovery. So we wire the whole thing here.
 *
 * Structure written:
 *   .vercel/output/
 *   ├── config.json                              # routes + crons (v3 schema)
 *   ├── static/                                  # SPA assets (copied from
 *   │                                              apps/web/dist/client/)
 *   └── functions/
 *       └── api/index.func/
 *           ├── .vc-config.json                  # Node serverless function
 *           └── index.mjs                        # pre-bundled Hono entry
 *
 * Vercel's docs (https://vercel.com/docs/build-output-api/configuration)
 * are the source of truth for the schema — bump the runtime version when
 * Vercel deprecates the current one.
 */
import { fileURLToPath } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Copy an npm package + its full runtime dependency closure into a function's
 * `node_modules`. Used for `sharp`, which is left external in the Bun bundle
 * because its native `@img/*` addon can't be inlined — the Lambda needs the
 * package on disk to `require("sharp")` at runtime. Resolving from the build
 * host means only the host platform's `@img/*` binary (linux-x64 on Vercel) is
 * copied; un-installed optional platform packages just fail to resolve and are
 * skipped. Best-effort: a failure leaves `sharp` absent → the adapter degrades
 * to passthrough (clean 422), never a broken deploy.
 */
const copyNpmClosure = (
  entryFrom: string,
  roots: string[],
  destNodeModules: string,
): number => {
  const seen = new Set<string>();
  // Each queue item carries the dir of the package that requires it, so deps
  // resolve through Bun's isolated `node_modules/.bun` store correctly.
  const queue = roots.map((name) => ({ name, from: entryFrom }));
  let copied = 0;
  while (queue.length > 0) {
    const { name, from } = queue.shift()!;
    if (seen.has(name)) continue;
    let pkgJsonPath: string;
    try {
      pkgJsonPath = createRequire(from).resolve(`${name}/package.json`);
    } catch {
      continue; // optional dep not installed for this platform — skip
    }
    seen.add(name);
    const srcDir = dirname(pkgJsonPath);
    cpSync(srcDir, join(destNodeModules, ...name.split("/")), {
      recursive: true,
      dereference: true,
    });
    copied += 1;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const childFrom = join(srcDir, "package.json");
    for (const dep of [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]) {
      if (!seen.has(dep)) queue.push({ name: dep, from: childFrom });
    }
  }
  return copied;
};

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_ROOT = join(REPO_ROOT, ".vercel/output");
const STATIC_DIR = join(OUTPUT_ROOT, "static");
const FUNC_DIR = join(OUTPUT_ROOT, "functions/api/index.func");
const FUNC_FILE = join(FUNC_DIR, "index.mjs");
const SPA_DIST = join(REPO_ROOT, "apps/web/dist/client");
const SOURCE_ENTRY = join(REPO_ROOT, "apps/web/src/server/entries/vercel-fn-entry.ts");
const SHIM_BUN_SQLITE = join(REPO_ROOT, "apps/web/src/server/shims/bun-sqlite-shim.ts");

// Clean any previous output so renames/deletes between deploys don't
// leave stale files in the upload. `.vercel/` itself is gitignored.
if (existsSync(OUTPUT_ROOT)) rmSync(OUTPUT_ROOT, { recursive: true });
mkdirSync(FUNC_DIR, { recursive: true });

// 1. Pre-bundle the Hono entry into the function dir. Self-contained —
//    every workspace `@backlex/*` and every npm dep is inlined, because
//    the Vercel runtime can't follow Bun's `node_modules/.bun` monorepo
//    store. `bun:sqlite` is aliased to its shim so the Node ESM loader
//    doesn't choke on the `bun:` protocol at module init.
const buildResult = await Bun.build({
  entrypoints: [SOURCE_ENTRY],
  outdir: FUNC_DIR,
  naming: "index.mjs",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "none",
  minify: false,
  // sharp is a native addon — leave it external so the bundler doesn't try to
  // inline the `.node` binary. It's resolved from the function's node_modules at
  // runtime (copied in below); if absent, the adapter degrades to passthrough.
  external: ["sharp", "@cf-wasm/photon"],
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

if (!buildResult.success) {
  for (const log of buildResult.logs) console.error(log);
  process.exit(1);
}

// Stage sharp + its native `@img/*` closure into the function's node_modules so
// `import("sharp")` resolves at runtime (image transforms on Node serverless).
// Best-effort — a failure just means the sharp adapter falls back to passthrough.
try {
  const count = copyNpmClosure(
    join(REPO_ROOT, "apps/web/package.json"),
    ["sharp"],
    join(FUNC_DIR, "node_modules"),
  );
  console.log(`[vercel] staged sharp closure (${count} packages) into function`);
} catch (err) {
  console.warn("[vercel] sharp closure copy skipped:", err);
}

// 2. Write the Node function descriptor (`.vc-config.json`). `nodejs22.x`
//    matches Vercel's current default LTS as of writing — bump when Vercel
//    rolls forward. `maxDuration` is the per-invocation timeout in seconds
//    (Vercel default 300, we keep room for slow cold-start DB reads).
writeFileSync(
  join(FUNC_DIR, ".vc-config.json"),
  `${JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      shouldAddSourcemapSupport: false,
      // Stream the response body incrementally instead of buffering it — the
      // realtime SSE subscribe endpoint (`text/event-stream`) must flush frames
      // to the client as they're written, not all at once when the function
      // ends. Without this Vercel buffers the whole body.
      supportsResponseStreaming: true,
      // Fluid Compute allows long durations; give SSE subscribe room to hold the
      // stream open (clients reconnect via Last-Event-ID when it eventually ends).
      maxDuration: 300,
    },
    null,
    2,
  )}\n`,
);

// 3. Copy the SPA build output as the static asset tree.
if (!existsSync(SPA_DIST)) {
  console.error(`SPA build not found at ${SPA_DIST} — run vite build first.`);
  process.exit(1);
}
mkdirSync(dirname(STATIC_DIR), { recursive: true });
cpSync(SPA_DIST, STATIC_DIR, { recursive: true });

// 4. Write the routing config. Build Output API uses `routes` (lower-level
//    than vercel.ts `rewrites`); the first match wins, so order matters.
//    `handle: "filesystem"` lets static files + the function fall through
//    on a direct hit before the SPA fallback eats them.
writeFileSync(
  join(OUTPUT_ROOT, "config.json"),
  `${JSON.stringify(
    {
      version: 3,
      routes: [
        // Funnel every /api/* path into the single pre-bundled function.
        // The capture is passed as `__path`; vercel-fn-entry.ts rebuilds
        // request.url before forwarding to Hono.
        { src: "^/api/(.*)$", dest: "/api/index?__path=$1" },
        // Non-/api Hono paths (`/mcp`, `/health`) need to skip the SPA
        // fallback too — without these the React router would catch
        // `POST /mcp` and Vercel would 405 it because static assets only
        // serve GET/HEAD. Same routing rule as Cloudflare's
        // `run_worker_first` and Netlify's per-path redirect block.
        // `__rawpath` (vs. `__path`) tells vercel-fn-entry to rebuild
        // the URL without the `/api/` prefix.
        { src: "^/mcp/?$", dest: "/api/index?__rawpath=mcp" },
        { src: "^/health/?$", dest: "/api/index?__rawpath=health" },
        // Let static assets + the function resolve directly.
        { handle: "filesystem" },
        // SPA fallback — the React client-side router takes over.
        { src: "^/(?!api/|assets/).*$", dest: "/index.html" },
      ],
      crons: [{ path: "/api/_cron/tick", schedule: "0 0 * * *" }],
    },
    null,
    2,
  )}\n`,
);

const funcOut = buildResult.outputs[0];
const sizeMb = funcOut ? (funcOut.size / 1024 / 1024).toFixed(2) : "?";
console.log(`✓ Wrote Build Output API tree to ${OUTPUT_ROOT}`);
console.log(`  - function: ${FUNC_FILE} (${sizeMb} MB)`);
console.log(`  - static:   ${STATIC_DIR}/ (from ${SPA_DIST})`);
console.log(`  - config:   ${join(OUTPUT_ROOT, "config.json")}`);
