/**
 * Vercel Edge Function entry. Mount in `vercel.json` rewrites so any
 * `/api/*` path is handled by this single function.
 *
 * Runtime constraints (Edge):
 *   - No fs / no `bun:sqlite` → DATABASE_URL (Postgres) is required.
 *   - No CF bindings — set `S3_BUCKET` + `S3_ACCESS_KEY_ID` +
 *     `S3_SECRET_ACCESS_KEY` so the storage adapter switches to the
 *     `aws4fetch`-backed S3 path. Without it `fsStorage` is selected
 *     and writes are lost between invocations.
 *   - Cron triggers configured via `vercel.json::crons` hit
 *     `/api/_cron/tick`; that route calls the same `cronTick` the Bun
 *     scheduler / Workers `scheduled()` use.
 */
import { handle } from "hono/vercel";
import { createApp } from "../app";
import { cronTick } from "../services/scheduler";
import type { Env } from "../env";

export const config = { runtime: "edge" };

const buildEnv = (): Env => ({
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
  DATABASE_URL: process.env.DATABASE_URL,
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

// Lightweight cron endpoint that vercel.json points its `crons[]` at. The
// shared cronTick is idempotent + deduped by `lastTickAt`, so multiple
// triggers per minute (Vercel cron's at-least-once semantics) are safe.
app.get("/api/_cron/tick", async (c) => {
  await cronTick(buildEnv());
  return c.json({ ok: true, ts: Date.now() });
});

export default handle(app);
