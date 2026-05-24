import { routes, type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: null,
  installCommand: "bun install --frozen-lockfile",
  buildCommand:
    "DEPLOY_TARGET=vercel bun run --cwd apps/web build && bun scripts/build-vercel-fn.ts",
  outputDirectory: "apps/web/dist/client",

  // No /api/* rewrite — `api/[...all].ts` (the pre-bundled Vercel function)
  // already catches every `/api/*` path via Vercel's filesystem routing,
  // and `request.url` arrives intact (a rewrite to `/api/index` would
  // strip the original path and confuse Hono's router).
  rewrites: [
    // SPA fallback: anything not /api/* and not /assets/* serves index.html
    // so the React client-side router can take over.
    routes.rewrite("/((?!api/|assets/).*)", "/index.html"),
  ],

  crons: [{ path: "/api/_cron/tick", schedule: "0 0 * * *" }],
};
