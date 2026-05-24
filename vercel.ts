import { routes, type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: null,
  installCommand: "bun install --frozen-lockfile",
  buildCommand:
    "DEPLOY_TARGET=vercel bun run --cwd apps/web build && bun scripts/build-vercel-fn.ts",
  outputDirectory: "apps/web/dist/client",

  rewrites: [
    // Catch-all for `/api/*` — Vercel's "Other Frameworks" filesystem
    // routing only does literal filename matching (no [...slug] syntax
    // outside Next.js), so every API path is funneled into the single
    // pre-bundled function at `api/index.mjs`. The capture group is
    // passed through as `__path` so the handler in `vercel-fn-entry.ts`
    // can rebuild the original URL before forwarding to Hono.
    routes.rewrite("/api/(.*)", "/api/index?__path=$1"),
    // SPA fallback: anything not /api/* and not /assets/* serves index.html
    // so the React client-side router can take over.
    routes.rewrite("/((?!api/|assets/).*)", "/index.html"),
  ],

  crons: [{ path: "/api/_cron/tick", schedule: "0 0 * * *" }],
};
