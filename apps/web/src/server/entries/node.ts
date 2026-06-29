/**
 * Standalone Node.js (≥ 20) self-host entry — the Node counterpart of
 * `bun.ts`. Runs the same Hono app on a long-running Node HTTP server via
 * `@hono/node-server`, so you can self-host on plain Node without Bun.
 *
 * Built into a runnable bundle by `scripts/build-node.ts`
 * (`dist/node/server.mjs`), then `node dist/node/server.mjs`. The build aliases
 * `bun:sqlite` to a throwing shim (Node can't parse the `bun:` specifier) and
 * leaves `sharp` external (native addon). Everything else auto-selects for Node
 * in `buildContext`:
 *   - DB     → Postgres via `postgres-js` (set `DATABASE_URL`; Node has no
 *              `bun:sqlite`, so local SQLite would need libSQL/Turso instead).
 *   - Storage→ local fs (`node:fs`) or S3/R2 (`aws4fetch`) when `S3_BUCKET` set.
 *   - Image  → `sharp` (the sharp adapter is gated to Node).
 *   - Sandbox→ QuickJS-WASM (sync) or a remote-http executor.
 *   - Realtime → in-process SSE (single instance) or Upstash Redis when set.
 *   - Email  → SMTP (`nodemailer`) or any HTTP provider.
 *   - Cron   → `setInterval` scheduler (same as Bun).
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "../app";
import { mountSpa } from "../lib/spa";
// `setInterval`-based — runtime-agnostic despite the name; reused here for Node.
import { startBunScheduler } from "../services/scheduler";
import { type Env, envFromSource } from "../env";

const env: Env = {
  ...envFromSource(process.env),
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
};

const app = createApp(env);
// Serve the pre-built admin SPA (dist/client) for non-API routes.
mountSpa(app, serveStatic);
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`backlex api listening on http://localhost:${info.port}`);
});

startBunScheduler(env);
