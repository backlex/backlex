/**
 * Vercel Edge Function entry. Mount in `vercel.json` rewrites so any
 * `/api/*` path is handled by this single function.
 *
 * Runtime constraints (Edge):
 *   - No fs, no `bun:sqlite`, no `node:net`/`node:tls` → DATABASE_URL is
 *     required AND `DATABASE_DRIVER=neon-http` must be set (postgres-js
 *     can't open TCP from a V8 isolate). Point DATABASE_URL at a Neon DB
 *     or a self-hosted Neon `wsproxy` fronting any Postgres.
 *   - No CF bindings — set `S3_BUCKET` + `S3_ACCESS_KEY_ID` +
 *     `S3_SECRET_ACCESS_KEY` so the storage adapter switches to the
 *     `aws4fetch`-backed S3 path. `buildContext` refuses to fall back to
 *     local-fs on edge (every upload would be lost between invocations).
 *   - SAML / LDAP / Realtime are unavailable; `buildContext` and the route
 *     gates return 503 for those features on this runtime.
 *   - Cron triggers configured via `vercel.json::crons` hit
 *     `/api/_cron/tick`. The route requires `x-cron-secret: $CRON_SECRET`
 *     to keep the public internet from triggering jobs.
 */
import { handle } from "hono/vercel";
import { timingSafeEqual } from "../lib/timing";
import { createApp } from "../app";
import { cronTick } from "../services/scheduler";
import type { Env } from "../env";

export const config = { runtime: "edge" };

const buildEnv = (): Env => ({
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_DRIVER: process.env.DATABASE_DRIVER as Env["DATABASE_DRIVER"],
  CRON_SECRET: process.env.CRON_SECRET,
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
  FUNCTIONS_FETCH_ALLOW: process.env.FUNCTIONS_FETCH_ALLOW,
  FUNCTIONS_EXEC_URL: process.env.FUNCTIONS_EXEC_URL,
  SANDBOX_RPC_TOKEN: process.env.SANDBOX_RPC_TOKEN,
  SELF_URL: process.env.SELF_URL ?? process.env.VERCEL_URL,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
});

const app = createApp(buildEnv());

// Cron endpoint that vercel.json points its `crons[]` at. The shared
// cronTick is idempotent + deduped by `lastTickAt`, so multiple triggers
// per minute (Vercel cron's at-least-once semantics) are safe. The path is
// publicly reachable, so require a shared-secret header; without it any
// internet caller could trigger jobs at arbitrary rates.
app.get("/api/_cron/tick", async (c) => {
  const env = buildEnv();
  const provided = c.req.header("x-cron-secret") ?? "";
  if (!env.CRON_SECRET || !timingSafeEqual(provided, env.CRON_SECRET)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await cronTick(env);
  return c.json({ ok: true, ts: Date.now() });
});

export default handle(app);
