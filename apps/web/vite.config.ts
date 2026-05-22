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
         * Pull the long-lived vendor code out of the main bundle so it
         * caches independently of admin changes and parallel-loads over HTTP/2.
         *
         * - `react-vendor`: react + react-dom + scheduler (rarely updated,
         *   biggest single dep block — worth caching aggressively).
         * - `radix-vendor`: @radix-ui/* + the radix-ui meta package (most of
         *   the shadcn primitive surface).
         *
         * Everything else — smaller deps and dynamic-imported chunks (e.g.
         * CodeMirror via the code-editor route, lazy admin/pages/* routes) —
         * is left to Rollup. A blanket "everything in node_modules → vendor"
         * catch-all would silently hoist those dynamic deps into the eager
         * bundle and regress first-paint, which is why the rule below stops
         * after the two explicit groups.
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
          // No catch-all: let Rollup decide the rest so dynamic-imported deps
          // (e.g. CodeMirror in the code-editor route) stay in their own
          // lazy chunk and don't get hoisted into the main bundle.
          return undefined;
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
