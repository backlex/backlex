/**
 * Vercel Function entry. Wired in `vercel.json` rewrites so any
 * `/api/*` path is handled by this single function. The `api/index.mjs`
 * shim (pre-bundled by `scripts/build-vercel-fn.ts` from
 * `vercel-fn-entry.ts`) imports the Hono app exported here and forwards
 * requests via `app.fetch(req)`.
 *
 * Deploys as a Node 22 serverless function — moved off Vercel Edge
 * because Edge can't transpile our `.ts` workspace package sources
 * (same issue Netlify Functions hits without pre-bundling). Node 22
 * keeps node:net/tls/crypto available, so SAML/LDAP/SMTP load.
 *
 * Runtime constraints (Node 22 Lambda):
 *   - DATABASE_URL is required. `DATABASE_DRIVER=neon-http` is still
 *     recommended (Vercel functions are short-lived; HTTP avoids the
 *     TCP handshake cost per cold start), and it's the path
 *     `buildContext` defaults to under `vercel` profile detection.
 *   - Storage: set `S3_BUCKET` + `S3_ACCESS_KEY_ID` +
 *     `S3_SECRET_ACCESS_KEY` so the adapter switches to S3. The
 *     function zip has no local fs to fall back on.
 *   - Realtime SSE loads but is impractical (Lambda is stateless,
 *     module-level pub/sub Maps don't share across invocations,
 *     and function execution time caps the SSE stream).
 *   - Cron triggers configured via `vercel.json::crons` hit
 *     `/api/_cron/tick`. The route accepts EITHER `x-cron-secret:
 *     $CRON_SECRET` (manual callers) OR `Authorization: Bearer $CRON_SECRET`
 *     (what Vercel's cron sends automatically when CRON_SECRET is set as a
 *     project env var). Without a match the route 401s so the public
 *     internet can't trigger jobs.
 */
import { timingSafeEqual } from "../lib/timing";
import { createApp } from "../app";
import { cronTick } from "../services/scheduler";
import type { Env } from "../env";

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
  const headerSecret = c.req.header("x-cron-secret") ?? "";
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const provided = headerSecret || bearer;
  if (
    !env.CRON_SECRET ||
    !provided ||
    !timingSafeEqual(provided, env.CRON_SECRET)
  ) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await cronTick(env);
  return c.json({ ok: true, ts: Date.now() });
});

// Expose the Hono instance. `vercel-fn-entry.ts` (pre-bundled into
// `api/index.mjs`) wraps it with `(req) => app.fetch(req)` — the same
// pattern Netlify uses, just a different output path.
export default app;
