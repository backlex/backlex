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
import type { Env } from "../env";

const env: Env = {
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_DRIVER: process.env.DATABASE_DRIVER as Env["DATABASE_DRIVER"],
  LIBSQL_URL: process.env.LIBSQL_URL,
  LIBSQL_AUTH_TOKEN: process.env.LIBSQL_AUTH_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  OAUTH_GOOGLE_CLIENT_ID: process.env.OAUTH_GOOGLE_CLIENT_ID,
  OAUTH_GOOGLE_CLIENT_SECRET: process.env.OAUTH_GOOGLE_CLIENT_SECRET,
  OAUTH_GITHUB_CLIENT_ID: process.env.OAUTH_GITHUB_CLIENT_ID,
  OAUTH_GITHUB_CLIENT_SECRET: process.env.OAUTH_GITHUB_CLIENT_SECRET,
  OAUTH_APPLE_CLIENT_ID: process.env.OAUTH_APPLE_CLIENT_ID,
  OAUTH_APPLE_CLIENT_SECRET: process.env.OAUTH_APPLE_CLIENT_SECRET,
  AUTH_PLUGINS: process.env.AUTH_PLUGINS,
  EXTRA_TRUSTED_ORIGINS: process.env.EXTRA_TRUSTED_ORIGINS,
  FUNCTIONS_FETCH_ALLOW: process.env.FUNCTIONS_FETCH_ALLOW,
  FUNCTIONS_EXEC_URL: process.env.FUNCTIONS_EXEC_URL,
  SANDBOX_RPC_TOKEN: process.env.SANDBOX_RPC_TOKEN,
  SELF_URL: process.env.SELF_URL,
  CRON_SECRET: process.env.CRON_SECRET,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  R2_PUBLIC_BASE: process.env.R2_PUBLIC_BASE,
};

const app = createApp(env);
// Serve the pre-built admin SPA (dist/client) for non-API routes.
mountSpa(app, serveStatic);
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`backlex api listening on http://localhost:${info.port}`);
});

startBunScheduler(env);
