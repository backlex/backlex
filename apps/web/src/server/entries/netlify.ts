/**
 * Netlify Edge Function entry. Configured via `netlify.toml`'s
 * `[[edge_functions]]` block to claim `/api/*`.
 *
 * Runtime constraints (Deno Deploy):
 *   - No fs, no `bun:sqlite` → DATABASE_URL is required. Deno has a
 *     `node:net` polyfill, so postgres-js works in principle, but the
 *     recommended path is `DATABASE_DRIVER=neon-http` (no TCP handshake
 *     per cold-start, predictable behaviour across both Vercel + Netlify
 *     edges).
 *   - Storage: set `S3_BUCKET` + `S3_ACCESS_KEY_ID` +
 *     `S3_SECRET_ACCESS_KEY` for the `aws4fetch`-backed S3 adapter.
 *     `buildContext` refuses to fall back to local-fs on edge.
 *   - SAML / LDAP / Realtime are unavailable; route gates return 503.
 *   - Scheduled functions (cron) live in `netlify/functions/cron.ts`
 *     (separate Node function — see template). They POST to
 *     `/api/_cron/tick` with `x-cron-secret: $CRON_SECRET` so the dedupe
 *     state stays in one place AND the public path stays gated.
 */
import { handle } from "hono/netlify";
import { timingSafeEqual } from "../lib/timing";
import { createApp } from "../app";
import { cronTick } from "../services/scheduler";
import type { Env } from "../env";

const denoEnv = (key: string): string | undefined => {
  const d = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  return d?.env.get(key) ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key];
};

const buildEnv = (): Env => ({
  APP_URL: denoEnv("APP_URL") ?? "http://localhost:5173",
  AUTH_SECRET: denoEnv("AUTH_SECRET") ?? "dev-secret-change-me",
  DATABASE_URL: denoEnv("DATABASE_URL"),
  DATABASE_DRIVER: denoEnv("DATABASE_DRIVER") as Env["DATABASE_DRIVER"],
  CRON_SECRET: denoEnv("CRON_SECRET"),
  OPENAI_API_KEY: denoEnv("OPENAI_API_KEY"),
  RESEND_API_KEY: denoEnv("RESEND_API_KEY"),
  EMAIL_FROM: denoEnv("EMAIL_FROM"),
  OAUTH_GOOGLE_CLIENT_ID: denoEnv("OAUTH_GOOGLE_CLIENT_ID"),
  OAUTH_GOOGLE_CLIENT_SECRET: denoEnv("OAUTH_GOOGLE_CLIENT_SECRET"),
  OAUTH_GITHUB_CLIENT_ID: denoEnv("OAUTH_GITHUB_CLIENT_ID"),
  OAUTH_GITHUB_CLIENT_SECRET: denoEnv("OAUTH_GITHUB_CLIENT_SECRET"),
  OAUTH_APPLE_CLIENT_ID: denoEnv("OAUTH_APPLE_CLIENT_ID"),
  OAUTH_APPLE_CLIENT_SECRET: denoEnv("OAUTH_APPLE_CLIENT_SECRET"),
  AUTH_PLUGINS: denoEnv("AUTH_PLUGINS"),
  FUNCTIONS_FETCH_ALLOW: denoEnv("FUNCTIONS_FETCH_ALLOW"),
  FUNCTIONS_EXEC_URL: denoEnv("FUNCTIONS_EXEC_URL"),
  SANDBOX_RPC_TOKEN: denoEnv("SANDBOX_RPC_TOKEN"),
  SELF_URL: denoEnv("SELF_URL") ?? denoEnv("URL"),
  S3_BUCKET: denoEnv("S3_BUCKET"),
  S3_REGION: denoEnv("S3_REGION"),
  S3_ENDPOINT: denoEnv("S3_ENDPOINT"),
  S3_ACCESS_KEY_ID: denoEnv("S3_ACCESS_KEY_ID"),
  S3_SECRET_ACCESS_KEY: denoEnv("S3_SECRET_ACCESS_KEY"),
});

const app = createApp(buildEnv());

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
