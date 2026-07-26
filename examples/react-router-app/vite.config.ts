import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

// Unlike the other examples, this app does NOT need a dev proxy for its own
// data: loaders and actions call backlex from the server, so there's no browser
// origin involved and nothing to preflight. The proxy stays only for the
// end-user client bits (`app/backlex.client.ts`) that do run in the browser.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.BACKLEX_URL || "http://localhost:5173";
  return {
    plugins: [reactRouter(), tailwindcss()],
    resolve: {
      // `~` is declared in tsconfig `paths`, but that only teaches tsc. Vite
      // needs its own alias — and the dev SSR module runner is stricter than
      // the production build, so a missing alias here fails only at runtime.
      alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
    },
    server: {
      port: 5178,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure: (proxy) => {
            // better-auth enforces a CSRF Origin check on writes; rewrite the
            // forwarded Origin so local dev needs no EXTRA_TRUSTED_ORIGINS.
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("origin", apiTarget);
            });
          },
        },
      },
    },
  };
});
