import { routes, type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: null,
  installCommand: "bun install --frozen-lockfile",
  buildCommand:
    "DEPLOY_TARGET=vercel bun run --cwd apps/web build && bun scripts/build-vercel-fn.ts",
  outputDirectory: "apps/web/dist/client",

  // Force-register the pre-bundled function with Vercel. Without this,
  // Vercel's zero-config `api/` directory scan runs before `buildCommand`
  // produces `api/index.mjs`, so the file ships in the deploy zip but
  // isn't registered as a Function (production 404s on every /api path).
  // Explicit registration makes Vercel wait for the file to exist post-build
  // and wrap it as a Node serverless function under Fluid Compute.
  functions: {
    "api/index.mjs": {
      maxDuration: 60,
    },
  },

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
