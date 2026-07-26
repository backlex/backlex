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
