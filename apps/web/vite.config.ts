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
        plugins: ["@lingui/babel-plugin-lingui-macro"],
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
  ],
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
      ldapts: fileURLToPath(
        new URL("./src/server/shims/ldapts-shim.ts", import.meta.url),
      ),
    },
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Pull the long-lived vendor code into stable named chunks so it
         * caches independently of admin changes and parallel-loads over HTTP/2.
         *
         * - `react-vendor` / `radix-vendor` — large, rarely-updated cores.
         * - `vendor` — every other `node_modules` module, pinned to ONE
         *   deterministic chunk. Letting Rollup auto-split this remainder
         *   makes the chunk graph unstable across small source edits.
         * - CodeMirror / xyflow are deliberately left unpinned (`undefined`):
         *   they are reached only through lazy routes, and forcing them into a
         *   named chunk either hoists them eager or — when grouped with eager
         *   `vendor` — makes Rollup drop the dynamically-imported code
         *   entirely. `undefined` keeps them in their own lazy chunk.
         */
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "react-vendor";
          }
          if (
            id.includes("/node_modules/@radix-ui/") ||
            id.includes("/node_modules/radix-ui/")
          ) {
            return "radix-vendor";
          }
          if (
            id.includes("/node_modules/@codemirror/") ||
            id.includes("/node_modules/@lezer/") ||
            id.includes("/node_modules/@uiw/") ||
            id.includes("/node_modules/codemirror/") ||
            id.includes("/node_modules/@xyflow/")
          ) {
            return undefined;
          }
          // Worker: the GraphQL subsystem is reached only through the
          // dynamically-imported `/api/graphql` handler. Leaving it unpinned
          // (vs. the eager `vendor` chunk) lets Rollup keep it in its own lazy
          // chunk, out of the cold-start eval path. Same rationale as the
          // CodeMirror/xyflow client lazy routes above. Anything genuinely
          // reached eagerly too stays eager — Rollup decides by import graph.
          if (
            id.includes("/node_modules/graphql/") ||
            id.includes("/node_modules/graphql-yoga/") ||
            id.includes("/node_modules/@graphql-yoga/") ||
            id.includes("/node_modules/@graphql-tools/") ||
            id.includes("/node_modules/@envelop/")
          ) {
            return undefined;
          }
          // Worker: the SAML subsystem (samlify + its X.509/ASN.1/RSA graph) is
          // reached only through the dynamically-imported samlify adapter
          // (lib/auth-select → adapters/saml.samlify), used on-demand when a
          // workspace resolves a SAML provider. Keep it unpinned so it lands in
          // its own lazy chunk instead of the eager `vendor` chunk.
          if (
            id.includes("/node_modules/samlify/") ||
            id.includes("/node_modules/@peculiar/") ||
            id.includes("/node_modules/node-rsa/") ||
            id.includes("/node_modules/xml-crypto/") ||
            id.includes("/node_modules/xml-encryption/") ||
            id.includes("/node_modules/@xmldom/") ||
            id.includes("/node_modules/xpath/") ||
            id.includes("/node_modules/tsyringe/") ||
            id.includes("/node_modules/reflect-metadata/")
          ) {
            return undefined;
          }
          // Worker: the WebAuthn/passkey plugin (@better-auth/passkey +
          // @simplewebauthn + its CBOR/base64 graph) is dynamically imported by
          // packages/auth only when the `passkey` auth plugin is enabled. Keep
          // it unpinned so it stays out of the eager chunk when passkeys are off.
          if (
            id.includes("/node_modules/@better-auth/passkey/") ||
            id.includes("/node_modules/@simplewebauthn/") ||
            id.includes("/node_modules/@hexagon/") ||
            id.includes("/node_modules/cbor-x/") ||
            id.includes("/node_modules/cbor/")
          ) {
            return undefined;
          }
          return "vendor";
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
