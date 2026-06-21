/**
 * Google Cloud Functions (2nd gen) entry — the GCF counterpart of `vercel.ts`
 * / `lambda.ts`. GCF 2nd gen runs on Cloud Run and uses the **Functions
 * Framework**, whose `http()` registers an Express-style `(req, res)` handler.
 * Hono's `getRequestListener(app.fetch)` returns exactly that listener
 * (`IncomingMessage`/`ServerResponse` — Express's req/res extend those), so the
 * whole `/api/*` surface is fronted by one registered function with no manual
 * event mapping.
 *
 * Deploy entry-point: the registered name below, **`api`**:
 *   gcloud functions deploy backlex \
 *     --gen2 --runtime=nodejs22 --entry-point=api --trigger-http \
 *     --source=apps/web/dist/gcp --allow-unauthenticated
 *
 * Built into a single-file bundle by `scripts/build-gcp.ts`
 * (`apps/web/dist/gcp/index.mjs` + a tiny `package.json` whose `main` points at
 * it). `@google-cloud/functions-framework` is left EXTERNAL — the GCF buildpack
 * provides it, and `http()` must register on the runtime's own framework
 * instance, not a second bundled copy.
 *
 * Because GCF 2nd gen is Cloud Run under the hood (long-lived container,
 * streaming responses), there's none of the `awslambda`-streaming dance Lambda
 * needs — SSE works natively. Runtime constraints otherwise match the
 * Vercel/Netlify Node functions:
 *   - DB: no `bun:sqlite` → **Postgres** (`DATABASE_URL`); `neon-http` avoids a
 *     cold-start TCP handshake. libSQL/Turso also works.
 *   - Storage: container fs is ephemeral → set `S3_BUCKET` +
 *     `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (`aws4fetch`; points at GCS's
 *     S3-compatible XML API or any S3).
 *   - Realtime: instances scale to zero / fan out, so module-level pub/sub
 *     doesn't hold → set `UPSTASH_REDIS_REST_*`.
 *   - SAML, LDAP, SMTP all work (Node 22 raw TCP).
 *   - Image transforms run through `sharp` (native addon resolves from the
 *     deployed `node_modules`).
 *   - Cron: a **Cloud Scheduler** job hits `/api/_cron/tick` with
 *     `x-cron-secret: $CRON_SECRET`. The shared `cronTick` is idempotent +
 *     deduped, so at-least-once delivery is safe; the route 401s without the
 *     secret.
 */
import { http } from "@google-cloud/functions-framework";
import { getRequestListener } from "@hono/node-server";
import { timingSafeEqual } from "../lib/timing";
import { createApp } from "../app";
import { cronTick } from "../services/scheduler";
import type { Env } from "../env";

const buildEnv = (): Env => ({
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_DRIVER: process.env.DATABASE_DRIVER as Env["DATABASE_DRIVER"],
  LIBSQL_URL: process.env.LIBSQL_URL,
  LIBSQL_AUTH_TOKEN: process.env.LIBSQL_AUTH_TOKEN,
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
  EXTRA_TRUSTED_ORIGINS: process.env.EXTRA_TRUSTED_ORIGINS,
  FUNCTIONS_FETCH_ALLOW: process.env.FUNCTIONS_FETCH_ALLOW,
  FUNCTIONS_EXEC_URL: process.env.FUNCTIONS_EXEC_URL,
  SANDBOX_RPC_TOKEN: process.env.SANDBOX_RPC_TOKEN,
  SELF_URL: process.env.SELF_URL,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  R2_PUBLIC_BASE: process.env.R2_PUBLIC_BASE,
  LOG_LEVEL: process.env.LOG_LEVEL,
  API_RATE_LIMIT_MAX: process.env.API_RATE_LIMIT_MAX,
  API_RATE_LIMIT_WINDOW_MS: process.env.API_RATE_LIMIT_WINDOW_MS,
  API_RATE_LIMIT_DISABLED: process.env.API_RATE_LIMIT_DISABLED,
});

const app = createApp(buildEnv());

// Cron endpoint Cloud Scheduler points at. Mirrors the Vercel/Netlify/Lambda
// cron route: cronTick is idempotent + deduped by `lastTickAt`, so Scheduler's
// at-least-once delivery is safe. Accept `x-cron-secret` OR `Authorization:
// Bearer`; without a match it 401s so the public internet can't trigger jobs.
app.get("/api/_cron/tick", async (c) => {
  const env = buildEnv();
  const headerSecret = c.req.header("x-cron-secret") ?? "";
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const provided = headerSecret || bearer;
  if (!env.CRON_SECRET || !provided || !timingSafeEqual(provided, env.CRON_SECRET)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await cronTick(env);
  return c.json({ ok: true, ts: Date.now() });
});

// Register the HTTP function. Deploy with `--entry-point=api`. The Functions
// Framework drives the Node `(req, res)` listener Hono produces from `app.fetch`.
http("api", getRequestListener(app.fetch));
