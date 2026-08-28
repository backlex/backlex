import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import * as babel from "@babel/core";
import { cloudflare } from "@cloudflare/vite-plugin";
import { lingui } from "@lingui/vite-plugin";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Runs the Lingui macro on EVERY client `.ts`/`.tsx` that imports it.
 *
 * The macro must not be delegated to `@vitejs/plugin-react`'s Babel pass:
 * plugin-react skips Babel for files its heuristic deems JSX-free, so a
 * macro in such a file survives to runtime and throws ("executed outside
 * the context of compilation"). This `enforce: "pre"` pass transforms the
 * macro on all client files first; plugin-react then does the JSX/TS pass.
 */
function linguiMacro(): Plugin {
  return {
    name: "lingui-macro",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0];
      if (!file.includes("/src/client/") || !/\.[cm]?tsx?$/.test(file)) {
        return null;
      }
      if (!code.includes("@lingui/")) return null;
      const result = await babel.transformAsync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        // Parse TS (+ JSX for .tsx); apply ONLY the macro plugin — types and
        // JSX are left intact for plugin-react / esbuild to handle next.
        parserOpts: {
          plugins: file.endsWith("x")
            ? ["typescript", "jsx"]
            : ["typescript"],
        },
        // `descriptorFields: "message"` keeps the English source text next to
        // the component that renders it. The default is `"auto"`, which means
        // `"id-only"` in a production build — every `<Trans>Save</Trans>`
        // becomes `<Trans id="gkzAEM"/>` and the readable text survives ONLY in
        // the compiled `en` catalog. That made the catalog a runtime
        // dependency, and a 92 KB gzip one: a single monolithic module holding
        // every string in the admin, loaded before first paint by everybody —
        // including a stranger opening a public booking link, who needs about
        // four of them.
        //
        // A catalog cannot be code-split, because message ids are content
        // hashes with no route to group them by; carving it up would mean
        // hand-maintaining "which catalog does this file belong to", the same
        // question `pages/` vs `parity/` was just deleted for asking. Keeping
        // the message inline makes the strings split themselves — they travel
        // in whichever chunk uses them, for free, forever. `en` therefore has
        // no runtime catalog at all (see admin/i18n.ts); translated locales are
        // unaffected and still load their `.po` on demand.
        plugins: [
          ["@lingui/babel-plugin-lingui-macro", { descriptorFields: "message" }],
        ],
      });
      return result?.code != null
        ? { code: result.code, map: result.map }
        : null;
    },
  };
}

/**
 * Prepended to the top of every Worker chunk to synthesize a `require`.
 *
 * Cloudflare Workers run ESM under `nodejs_compat` but expose NO `require`
 * global. Any bundled dependency that calls `require("node:buffer")` at
 * module-eval time — e.g. `@whatwg-node`'s `createNodePonyfill`, pulled in
 * transitively by graphql-yoga — therefore crashes the Worker during deploy
 * validation:
 *
 *   Uncaught Error: Calling `require` for "node:buffer" in an environment
 *   that doesn't expose the `require` function.   [code 10021]
 *
 * Whether that `require` call ends up in the bundle is NOT deterministic: the
 * Cloudflare Workers Builds host (linux-x64, bun 1.2) resolves a different
 * `@whatwg-node` variant than a local macOS (arm64, bun 1.3) build, so the
 * deploy fails in CI while building clean locally. Rather than chase the
 * resolution, we make `require` actually work at runtime: rolldown's
 * `__require` stub delegates to a global `require` if one exists, so we
 * synthesize one from `node:module`'s `createRequire` (provided by
 * nodejs_compat), with a static map of the common builtins as a fallback.
 * As a prepended banner it runs before any other top-level chunk code.
 */
const WORKER_REQUIRE_SHIM = [
  'import { createRequire as __cfCreateRequire } from "node:module";',
  'import * as __cfBuffer from "node:buffer";',
  'import * as __cfEvents from "node:events";',
  'import * as __cfStream from "node:stream";',
  'import * as __cfUtil from "node:util";',
  'import * as __cfAsyncHooks from "node:async_hooks";',
  "if (!globalThis.require) {",
  "  const __cfBuiltins = {",
  '    "node:buffer": __cfBuffer, buffer: __cfBuffer,',
  '    "node:events": __cfEvents, events: __cfEvents,',
  '    "node:stream": __cfStream, stream: __cfStream,',
  '    "node:util": __cfUtil, util: __cfUtil,',
  '    "node:async_hooks": __cfAsyncHooks, async_hooks: __cfAsyncHooks,',
  "  };",
  "  let __cfNativeRequire;",
  '  try { __cfNativeRequire = __cfCreateRequire("file:///worker.js"); } catch {}',
  "  globalThis.require = (id) => {",
  "    const mod = __cfBuiltins[id];",
  "    if (mod) return mod.default ?? mod;",
  "    if (__cfNativeRequire) return __cfNativeRequire(id);",
  "    throw new Error(\"require() unavailable for '\" + id + \"' on Cloudflare Workers\");",
  "  };",
  "}",
].join("\n");

/**
 * Chunking, decided per build environment.
 *
 * This used to be ONE `manualChunks` function shared by the browser SPA and the
 * Worker, and the two want opposite things. Its default — pin every remaining
 * `node_modules` module into a single eager `vendor` chunk — is a reasonable
 * answer for a Worker, where there is one entry and no route graph to split
 * along. On the client it is the wrong one by construction: a lazily-reached
 * package gets nailed into a chunk something eager already pulls, silently
 * undoing the `import()` that was supposed to defer it. Every leak was then
 * fixed by hand-adding another `return undefined` branch — twelve of them, each
 * written after the fact, each only as good as somebody noticing. `react-day-
 * picker` + `date-fns` (~300 KB raw, reachable only from the date field editor)
 * were the ones nobody had noticed yet, and `redux` had leaked past a branch
 * that listed `@reduxjs/` and `react-redux/` but not the bare package.
 *
 * Split in two, each side states its own rule and the exception lists shrink to
 * what is actually true of that build:
 *
 * - **client** — pin React and nothing else. Everything else is left to the
 *   bundler, which places a module in the chunk of whatever actually reaches
 *   it. That is the behaviour all twelve exceptions were approximating one
 *   package at a time, so none of them are needed here and a thirteenth cannot
 *   be owed.
 * - **worker** — keep the `vendor` pin, and keep every server-side exception
 *   exactly as it was. Each was added after a specific cold-start regression
 *   (libsql, samlify, graphql, …) and none of them is a client concern. The
 *   Worker output is byte-identical across this change.
 */
function chunkStrategy(): Plugin {
  return {
    name: "chunk-strategy",
    configEnvironment(name) {
      const manualChunks =
        name === "client" ? clientManualChunks : workerManualChunks;
      return { build: { rollupOptions: { output: { manualChunks } } } };
    },
  };
}

/**
 * Browser SPA. React is pinned because it is large, changes rarely, and is
 * reached from literally every route — a stable name for it is a cache win with
 * no downside. Everything else returns `undefined`, which is not "no opinion"
 * but the actual opinion: let the import graph decide, so a package behind a
 * lazy route stays behind it.
 *
 * Radix used to be pinned here too, on the same reasoning, and it was wrong for
 * a reason worth writing down: pinning it SPLIT REACT. Some react modules ended
 * up assigned to `radix-vendor` (a module can only live in one chunk, and the
 * two rules fought over the shared graph), which made a chunk named after a
 * component library a hard dependency of everything that renders anything —
 * eager, 45 KB gzip, in front of first paint for a visitor who will never open
 * a dropdown. Unpinned, React is whole again and Radix loads with whichever
 * lazy chunk actually uses it. Total bytes across the whole build are unchanged
 * (1286 KB gzip either way); it is purely a question of when they arrive.
 */
const clientManualChunks = (id: string): string | undefined => {
  if (!id.includes("node_modules")) return undefined;
  if (
    id.includes("/node_modules/react/") ||
    id.includes("/node_modules/react-dom/") ||
    id.includes("/node_modules/scheduler/")
  ) {
    return "react-vendor";
  }
  return undefined;
};

/**
 * Cloudflare Worker. One entry, no routes to split along, so the remainder is
 * pinned to a single deterministic `vendor` chunk rather than left to Rollup —
 * which otherwise reshuffles the chunk graph on small source edits.
 *
 * Each `return undefined` below names a subsystem reached ONLY through a
 * dynamic import. Without the branch the `return "vendor"` at the bottom pins
 * its whole graph into the eager chunk and puts it back in the cold-start eval
 * path, undoing the `import()`. Anything genuinely reached eagerly as well
 * stays eager regardless — Rollup decides that from the import graph.
 */
const workerManualChunks = (id: string): string | undefined => {
  if (!id.includes("node_modules")) return undefined;
  // The GraphQL subsystem — reached only through the dynamically-imported
  // `/api/graphql` handler.
  if (
    id.includes("/node_modules/graphql/") ||
    id.includes("/node_modules/graphql-yoga/") ||
    id.includes("/node_modules/@graphql-yoga/") ||
    id.includes("/node_modules/@graphql-tools/") ||
    id.includes("/node_modules/@envelop/")
  ) {
    return undefined;
  }
  // The postgres.js wire driver — reached ONLY through the dynamically-imported
  // `#postgres-driver` (services/migrate.ts — server-side external-DB
  // migration). D1-only instances never load it. (The static `postgres`
  // specifier is stubbed separately via resolve.alias above.)
  if (id.includes("/node_modules/postgres/")) {
    return undefined;
  }
  // The SAML subsystem (samlify + its X.509/ASN.1/RSA graph) — reached only
  // through the dynamically-imported samlify adapter (lib/auth-select →
  // adapters/saml.samlify), used on-demand when a workspace resolves a SAML
  // provider.
  if (
    id.includes("/node_modules/samlify/") ||
    id.includes("/node_modules/@peculiar/") ||
    id.includes("/node_modules/node-rsa/") ||
    id.includes("/node_modules/xml-crypto/") ||
    id.includes("/node_modules/xml-encryption/") ||
    // samlify's actual XML graph uses the @authenio scope + these helpers;
    // without the exact patterns they fell through to the eager `vendor` chunk
    // (same class of bug as libsql) instead of the lazy samlify chunk.
    id.includes("/node_modules/@authenio/") ||
    id.includes("/node_modules/asn1/") ||
    id.includes("/node_modules/xml-escape/") ||
    id.includes("/node_modules/safer-buffer/") ||
    id.includes("/node_modules/@xmldom/") ||
    id.includes("/node_modules/xpath/") ||
    id.includes("/node_modules/tsyringe/") ||
    id.includes("/node_modules/reflect-metadata/")
  ) {
    return undefined;
  }
  // The WebAuthn/passkey plugin (@better-auth/passkey + @simplewebauthn + its
  // CBOR/base64 graph) — dynamically imported by packages/auth only when the
  // `passkey` auth plugin is enabled.
  if (
    id.includes("/node_modules/@better-auth/passkey/") ||
    id.includes("/node_modules/@simplewebauthn/") ||
    id.includes("/node_modules/@hexagon/") ||
    id.includes("/node_modules/cbor-x/") ||
    id.includes("/node_modules/cbor/")
  ) {
    return undefined;
  }
  // The libSQL/Turso driver — reached ONLY through the dynamically-imported
  // `@backlex/db/sqlite/libsql` factory (context.ts, and only when LIBSQL_URL
  // is set — never on the D1-backed Workers build).
  if (
    id.includes("/node_modules/@libsql/") ||
    id.includes("/node_modules/libsql/") ||
    id.includes("/node_modules/drizzle-orm/libsql/")
  ) {
    return undefined;
  }
  // The in-isolate QuickJS-WASM function sandbox — reached only through the
  // dynamically-imported provider (services/sandbox), used when a stored
  // function actually executes in-isolate. The WASM blob is large.
  if (
    id.includes("/node_modules/quickjs-emscripten") ||
    id.includes("/node_modules/@jitl/quickjs") ||
    id.includes("/node_modules/@cf-wasm/")
  ) {
    return undefined;
  }
  // `yaml` — used only by the on-demand `/api/openapi.yaml` handler.
  if (id.includes("/node_modules/yaml/")) {
    return undefined;
  }
  // better-auth and the kysely query builder under it — the single largest
  // thing in the worker's eager graph, and it builds its plugin/schema objects
  // at module scope. Both auth instances are constructed behind an `import()`
  // (`context.ts::buildContext`, `services/tenant-auth.ts`), so without this
  // branch the `return "vendor"` below would pin all of it back into the
  // cold-start eval path and the dynamic imports would buy nothing. Only the
  // packages that are better-auth's own graph are listed: `zod`, `jose` and
  // `drizzle-orm` are shared with eager code, so naming them here would change
  // nothing (Rollup keeps a module eager when anything eager imports it) while
  // making this list read as though it did.
  if (
    id.includes("/node_modules/better-auth/") ||
    id.includes("/node_modules/@better-auth/") ||
    id.includes("/node_modules/better-call/") ||
    id.includes("/node_modules/kysely/")
  ) {
    return undefined;
  }
  return "vendor";
};

/**
 * Configures the Worker (non-`client`) build for Cloudflare:
 *
 * 1. `platform: "neutral"` — rolldown otherwise emits an EAGER
 *    `var __require = createRequire(import.meta.url)` runtime helper for
 *    `platform: "node"`, which throws at module top level on Workers because
 *    `import.meta.url` is `undefined` (deploy validation, code 10021). The
 *    build host's runtime picks the default platform (node 22 → "node" =
 *    crash, node 26 → "neutral" = safe), so pinning it keeps deploys
 *    deterministic. "neutral" yields a LAZY `__require` stub that delegates
 *    to a global `require` when present — which is exactly what (2) supplies.
 * 2. `output.banner: WORKER_REQUIRE_SHIM` — see above.
 *
 * The `client` (browser SPA) environment is left untouched.
 */
function workerCloudflareCompat(): Plugin {
  return {
    name: "worker-cloudflare-compat",
    configEnvironment(name) {
      if (name === "client") return null;
      // `platform` is a rolldown-vite extension to rollupOptions; the upstream
      // Rollup types don't know it, hence the cast.
      return {
        build: {
          rollupOptions: {
            platform: "neutral",
            output: { banner: WORKER_REQUIRE_SHIM },
          },
        },
      } as { build: { rollupOptions: Record<string, unknown> } };
    },
  };
}

/**
 * Single Vite app for both admin SPA and the Hono Worker. The
 * `@cloudflare/vite-plugin` reads `wrangler.toml` and runs the Worker
 * (entry from `wrangler.toml::main`) inside Vite's dev server with
 * miniflare — so `bun run dev` gives HMR for the SPA AND for the API on
 * one port. Production: `vite build` emits the SPA into `dist/` and
 * bundles the Worker; `wrangler deploy` ships both.
 */
/**
 * Build-time version metadata, derived once at config eval so the running
 * instance can report what it actually is instead of a hand-edited constant
 * (Settings → About + GET /api/admin/settings/runtime). Everything is wrapped
 * in try/catch so a checkout without `git`/`node_modules` (e.g. a source
 * tarball) still builds — it just falls back to package.json / "unknown".
 */
function git(cmd: string, fallback: string): string {
  try {
    return (
      execSync(`git ${cmd}`, {
        stdio: ["ignore", "pipe", "ignore"],
        cwd: fileURLToPath(new URL(".", import.meta.url)),
      })
        .toString()
        .trim() || fallback
    );
  } catch {
    return fallback;
  }
}
const pkgVersion = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ).version as string;
  } catch {
    return "0.0.0";
  }
})();
// Prefer the cloud template tag (set by scripts/build-worker-template.ts),
// then the nearest git tag, then the package.json version. Release tags are
// `worker-vX.Y.Z` → strip the `worker-` prefix for display.
const appVersion = (
  process.env.TEMPLATE_VERSION ??
  git("describe --tags --always --dirty", `v${pkgVersion}`)
).replace(/^worker-/, "");
const gitCommit = git("rev-parse --short HEAD", "unknown");
const buildDate = new Date().toISOString().slice(0, 10);
const wranglerVersion = (() => {
  try {
    return createRequire(import.meta.url)("wrangler/package.json")
      .version as string;
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  // `linguiMacro()` transforms the Lingui macro (must run before react()).
  // `lingui()` compiles `.po` catalog imports to runtime message objects.
  plugins: [
    linguiMacro(),
    react(),
    lingui(),
    tailwind(),
    cloudflare(),
    // Must run after cloudflare() so it wins the merge for the Worker env.
    workerCloudflareCompat(),
    chunkStrategy(),
  ],
  // Bake the worker-template version into the bundle so a running instance can
  // report it (GET /health → `version`). `scripts/build-worker-template.ts`
  // sets TEMPLATE_VERSION before the build; a plain `bun run dev`/`build`
  // leaves it unset → "dev". Replaced textually at build time.
  define: {
    __TEMPLATE_VERSION__: JSON.stringify(process.env.TEMPLATE_VERSION ?? "dev"),
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __BUILD_DATE__: JSON.stringify(buildDate),
    __WRANGLER_VERSION__: JSON.stringify(wranglerVersion),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
      // bun:sqlite is imported transitively (drizzle bun-sqlite + packages/db's
      // createBunSqliteClient). The Worker never calls those code paths (D1 is
      // selected via env.D1), but Vite's bundler still resolves the import.
      // The shim throws if anything ever does call it on Workers.
      "bun:sqlite": fileURLToPath(
        new URL("./src/server/shims/bun-sqlite-shim.ts", import.meta.url),
      ),
      // nodemailer (the SMTP email adapter) pulls in node:net/node:tls, which
      // the Workers bundle can't resolve. SMTP is never selected on Workers —
      // this stub keeps the bundler happy and throws if anything calls it.
      nodemailer: fileURLToPath(
        new URL("./src/server/shims/nodemailer-shim.ts", import.meta.url),
      ),
      // ldapts (the LDAP/AD auth adapter) also needs node:net/node:tls. LDAP
      // is never selected on Workers — same throwing-stub pattern as above.
      postgres: fileURLToPath(
        new URL("./src/server/shims/postgres-shim.ts", import.meta.url),
      ),
      "@neondatabase/serverless": fileURLToPath(
        new URL("./src/server/shims/neon-shim.ts", import.meta.url),
      ),
      ldapts: fileURLToPath(
        new URL("./src/server/shims/ldapts-shim.ts", import.meta.url),
      ),
      // sharp is a native addon — never loadable on the Workers isolate. The
      // sharp image adapter is gated out on Workers (CF Image Resizing is used
      // at the edge); this stub keeps the dynamic import out of the bundle.
      sharp: fileURLToPath(
        new URL("./src/server/shims/sharp-shim.ts", import.meta.url),
      ),
      // @cf-wasm/photon backs the Deno image fallback (image.wasm.ts), gated off
      // on Workers; stub it so its WASM blob never enters the Worker bundle.
      "@cf-wasm/photon": fileURLToPath(
        new URL("./src/server/shims/photon-shim.ts", import.meta.url),
      ),
      // Postgres schema/driver are never used on the D1 (sqlite) Workers build,
      // but `@backlex/db/pg` is statically imported across ~80 files and would
      // pull pg/schema.ts (every pgTable) + drizzle-orm/pg-core into the eager
      // cold-start bundle. Alias both pg entrypoints to sqlite-backed shims (the
      // pg code paths never run on D1). MORE-SPECIFIC `/schema` MUST come first —
      // @rollup/plugin-alias prefix-matches, so `@backlex/db/pg` would otherwise
      // also swallow `@backlex/db/pg/schema`. Source stays dual-dialect for
      // self-host Postgres; this only rewrites the Workers build.
      "@backlex/db/pg/schema": fileURLToPath(
        new URL("./src/server/shims/pg-schema-shim.ts", import.meta.url),
      ),
      "@backlex/db/pg": fileURLToPath(
        new URL("./src/server/shims/pg-shim.ts", import.meta.url),
      ),
    },
  },
  /**
   * Dev-server only. `packages/db/src/pg/index.ts` imports `postgres`, and the
   * Worker environment's dep scanner doesn't see it on the first pass — it's
   * reached lazily, so Vite discovers it mid-boot, re-runs the optimizer, and
   * asks the runner to reload. `@cloudflare/vite-plugin` loses that race: the
   * reloaded worker still references a pre-bundled chunk from the previous
   * pass, and the boot dies with "The file does not exist at
   * …/deps_backlex_admin/schemas-*.js".
   *
   * Excluding it removes the trigger rather than the symptom — there is no
   * second optimizer pass, so there is no reload. Nothing is lost: `postgres`
   * is aliased to a throwing shim above (D1/SQLite is what runs on Workers),
   * so pre-bundling it was never useful. The production build goes through
   * Rollup + that alias and is unaffected either way.
   */
  optimizeDeps: {
    exclude: ["postgres"],
  },
  /**
   * …and again, per environment.
   *
   * The block above reaches the CLIENT environment. The boot that dies is the
   * Worker one — `(backlex_admin)` in the log — and it keeps its own optimizer
   * with its own exclude list, which the root one does not feed. So the root
   * setting silenced the trigger everywhere except the one place it fires, and
   * the symptom came back looking like a fresh bug.
   *
   * Named for the Worker in `wrangler.toml`, which is what
   * `@cloudflare/vite-plugin` calls its environment.
   */
  environments: {
    backlex_admin: { optimizeDeps: { exclude: ["postgres"] } },
  },
  server: {
    host: true,
    port: 5173,
    // Vite's dev server installs its own `cors` middleware that short-circuits
    // every cross-origin OPTIONS preflight before the request can reach the
    // Cloudflare/miniflare Worker. That default reply echoes the request origin
    // but omits `Access-Control-Allow-Credentials`, so a *different-origin*
    // browser app doing a credentialed request (`credentials: include`, the
    // @backlex/client default) fails the preflight locally even though the real
    // POST succeeds and production is fine. Disabling Vite's cors lets the
    // preflight fall through to the Worker's own `cors()` middleware
    // (server/app.ts), which returns the correct credentialed headers.
    cors: false,
  },
});
