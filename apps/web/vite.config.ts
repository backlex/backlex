import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { lingui } from "@lingui/vite-plugin";
import { fileURLToPath, URL } from "node:url";

/**
 * Single Vite app for both admin SPA and the Hono Worker. The
 * `@cloudflare/vite-plugin` reads `wrangler.toml` and runs the Worker
 * (entry from `wrangler.toml::main`) inside Vite's dev server with
 * miniflare — so `bun run dev` gives HMR for the SPA AND for the API on
 * one port. Production: `vite build` emits the SPA into `dist/` and
 * bundles the Worker; `wrangler deploy` ships both.
 */
export default defineConfig({
  // `@lingui/babel-plugin-lingui-macro` runs inside plugin-react's Babel pass
  // so it only touches client `.tsx` (the Worker bundle never sees it).
  // `lingui()` compiles `.po` catalog imports to runtime message objects.
  plugins: [
    react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
    lingui(),
    tailwind(),
    cloudflare(),
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
