/**
 * Netlify Function (Node 22) Hono app + cron route. This builds the app and
 * is re-exported by `netlify-fn-entry.ts`, which Bun pre-bundles into
 * `apps/web/netlify/functions/api.mjs`; `netlify.toml` (`[functions]` +
 * redirects to `/.netlify/functions/api/*`) deploys THAT as a Node 22 v2
 * function. This is NOT a Netlify Edge / Deno Deploy entry — there is no
 * `[[edge_functions]]` block — so the Node-only constraints below apply.
 *
 * Runtime constraints (Netlify Node Function):
 *   - `bun:sqlite` is unavailable (shimmed) → use Postgres (`DATABASE_URL`,
 *     `neon-http` recommended) or libSQL. Node 22 has real TCP, so
 *     postgres-js works too.
 *   - Storage: the function fs is ephemeral, so set `S3_BUCKET` +
 *     `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (`aws4fetch` S3 adapter);
 *     `buildContext` refuses the local-fs fallback on Netlify (see
 *     `isNetlify()`).
 *   - Realtime: in-process pub/sub can't survive between invocations — set
 *     `UPSTASH_REDIS_REST_*` for the Redis long-poll transport.
 *   - SAML, LDAP, and SMTP all work here (Node 22 raw TCP) — these are only
 *     unavailable on the true edge isolates (Workers / Deno Deploy).
 *   - Image transforms go through the Netlify Image CDN (`/.netlify/images`)
 *     for public files; sharp isn't bundled into the function.
 *   - Cron: a scheduled function (`netlify.toml [[scheduled_functions]]`)
 *     POSTs `/api/_cron/tick` with `x-cron-secret: $CRON_SECRET` (defined
 *     below) so dedupe state stays in one place and the public path stays
 *     gated.
 */
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
  LIBSQL_URL: denoEnv("LIBSQL_URL"),
  LIBSQL_AUTH_TOKEN: denoEnv("LIBSQL_AUTH_TOKEN"),
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
  UPSTASH_REDIS_REST_URL: denoEnv("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: denoEnv("UPSTASH_REDIS_REST_TOKEN"),
  R2_PUBLIC_BASE: denoEnv("R2_PUBLIC_BASE"),
  LOG_LEVEL: denoEnv("LOG_LEVEL"),
  API_RATE_LIMIT_MAX: denoEnv("API_RATE_LIMIT_MAX"),
  API_RATE_LIMIT_WINDOW_MS: denoEnv("API_RATE_LIMIT_WINDOW_MS"),
  API_RATE_LIMIT_DISABLED: denoEnv("API_RATE_LIMIT_DISABLED"),
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

// Expose the Hono instance directly. The edge function shim in
// `apps/web/netlify/edge-functions/entry.ts` calls `app.fetch(req)` —
// no Hono Netlify adapter needed, which keeps `hono/netlify` out of
// the Deno edge bundle (Netlify's experimental npm resolver can't
// load it).
export default app;
