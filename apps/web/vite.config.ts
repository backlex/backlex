import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { lingui } from "@lingui/vite-plugin";
import * as babel from "@babel/core";
import { fileURLToPath, URL } from "node:url";

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
 * Pins the Worker build's bundler `platform` to `neutral`.
 *
 * rolldown picks a `__require` runtime helper based on the build platform.
 * For `platform: "node"` it emits an EAGER `var __require =
 * createRequire(import.meta.url)` that runs at module top level — and on
 * Cloudflare Workers `import.meta.url` is `undefined`, so `createRequire`
 * throws during deploy validation (`A request to .../versions failed …
 * argument 'path' … Received 'undefined'` [code 10021]) even though the
 * Worker never actually calls `require`. `platform: "neutral"` emits a LAZY
 * stub that only throws if `require` is genuinely invoked (it never is —
 * deps are bundled ESM or shimmed), so the bundle is safe.
 *
 * rolldown-vite leaves the Worker (server-consumer) environment's default
 * platform up to the runtime: Node 22 / Bun 1.2 resolves it to `"node"`
 * (the createRequire crash), Node 26 to `"neutral"`. That made the deploy
 * pass locally but fail in Cloudflare Workers Builds. Forcing `"neutral"`
 * here makes the output deterministic across every build host. `client`
 * (the browser SPA) is left untouched.
 */
function neutralWorkerPlatform(): Plugin {
  return {
    name: "neutral-worker-platform",
    configEnvironment(name) {
      if (name === "client") return null;
      // `platform` is a rolldown-vite extension to rollupOptions; the upstream
      // Rollup types don't know it, hence the cast.
      return {
        build: { rollupOptions: { platform: "neutral" } },
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
    neutralWorkerPlatform(),
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
