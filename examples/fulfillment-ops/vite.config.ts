import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Same-origin through the dev proxy, for the same reason the other examples do
// it: no CORS preflight, and better-auth's Origin check is satisfied by
// rewriting the forwarded Origin to the API's own.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_BACKLEX_PROXY_TARGET || "http://localhost:5173";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5181,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("origin", apiTarget);
            });
          },
        },
      },
    },
  };
});
