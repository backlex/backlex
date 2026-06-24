import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The example talks to the backlex API **same-origin** through this dev proxy:
// the browser only ever hits http://localhost:5176, and Vite forwards `/api/*`
// to the backend. Same-origin means no CORS preflight — which also sidesteps
// the fact that the `bun run dev` Vite server intercepts cross-origin OPTIONS
// preflights itself. In production you'd point `VITE_BACKLEX_URL` at your
// deployed API (cross-origin) and register the app's origin as trusted there.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_BACKLEX_PROXY_TARGET || "http://localhost:5173";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5176,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure: (proxy) => {
            // better-auth enforces a CSRF Origin check on writes. Rewrite the
            // forwarded Origin to the API's own origin so the backend trusts it
            // with no EXTRA_TRUSTED_ORIGINS / redirect-URL setup in local dev.
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("origin", apiTarget);
            });
          },
        },
      },
    },
  };
});
