/**
 * AWS Lambda entry — the Lambda counterpart of `vercel.ts` / `netlify.ts`.
 * Runs the same runtime-agnostic Hono app behind Hono's `aws-lambda`
 * adapter, so a single function fronts the whole `/api/*` surface.
 *
 * Two handlers are exported:
 *   - `handler`       — buffered. Works with **API Gateway** (REST v1 &
 *                       HTTP API v2 payloads), an **ALB** target group, or a
 *                       **Lambda Function URL** with the default (buffered)
 *                       invoke mode. This is the default most setups want.
 *   - `streamHandler` — response-streaming via `awslambda.streamifyResponse`
 *                       (Hono's `streamHandle`). Use ONLY behind a **Lambda
 *                       Function URL with `InvokeMode: RESPONSE_STREAM`**, where
 *                       it lets SSE / long responses flush incrementally instead
 *                       of buffering the whole body. API Gateway/ALB don't
 *                       support streaming — point those at `handler`.
 *
 * Built into a single-file bundle by `scripts/build-lambda.ts`
 * (`apps/web/dist/lambda/index.mjs`); the Lambda handler string is then
 * `index.handler` (or `index.streamHandler`). The build aliases `bun:sqlite`
 * to a throwing shim (the `bun:` specifier can't be parsed off-Bun) and leaves
 * `sharp` / `@libsql/client` external (native addons — ship them in the zip's
 * `node_modules` or a Lambda layer).
 *
 * Runtime constraints (AWS Lambda, Node 22.x — same shape as the Vercel/Netlify
 * Node functions):
 *   - DB: no `bun:sqlite` → use **Postgres** (`DATABASE_URL`). Lambda is short-
 *     lived, so `DATABASE_DRIVER=neon-http` (or RDS Proxy in front of
 *     postgres-js) avoids paying a TCP handshake on every cold start. Node 22
 *     has real TCP, so postgres-js works too.
 *   - Storage: the function fs is ephemeral → set `S3_BUCKET` +
 *     `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (`aws4fetch` S3 adapter).
 *     On AWS this is native S3; the local-fs fallback won't persist.
 *   - Realtime: module-level pub/sub Maps don't survive between invocations →
 *     set `UPSTASH_REDIS_REST_*` for the Redis long-poll transport. Buffered
 *     `handler` can't stream SSE at all; use `streamHandler` behind a streaming
 *     Function URL if you need live SSE.
 *   - SAML, LDAP, and SMTP all work here (Node 22 raw node:net/tls).
 *   - Image transforms go through `sharp` when the native addon is present in
 *     the deployment package; otherwise the adapter degrades to passthrough.
 *   - Cron: `setInterval` schedulers don't run on Lambda → drive an
 *     **EventBridge Scheduler** rule (or scheduled rule) that invokes the
 *     `/api/_cron/tick` route with `x-cron-secret: $CRON_SECRET`. The shared
 *     `cronTick` is idempotent + deduped by `lastTickAt`, so at-least-once
 *     delivery is safe. The path 401s without the secret so the public
 *     internet can't trigger jobs.
 */
import { handle, streamHandle } from "hono/aws-lambda";
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

// Cron endpoint EventBridge points at. Mirrors the Vercel/Netlify cron route:
// the shared cronTick is idempotent + deduped by `lastTickAt`, so EventBridge's
// at-least-once delivery is safe. Accept EITHER `x-cron-secret: $CRON_SECRET`
// (the header an EventBridge Scheduler rule sends) OR an `Authorization: Bearer
// $CRON_SECRET`; without a match the route 401s so the public internet can't
// trigger jobs.
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

// Buffered handler — API Gateway (v1 + v2), ALB, or a default Function URL.
export const handler = handle(app);

// Streaming handler — ONLY behind a Lambda Function URL with
// `InvokeMode: RESPONSE_STREAM`. Lets SSE / large bodies flush incrementally.
//
// `streamHandle()` calls `awslambda.streamifyResponse()` EAGERLY — and
// `awslambda` is a global the Lambda runtime only injects under the streaming
// invoke mode. Building it at module top level would throw `ReferenceError:
// awslambda is not defined` everywhere else (local invoke, the buffered
// `handler` deployment, the build's import check), so gate it on the global's
// presence. In a streaming Function URL runtime `awslambda` is defined before
// the handler module loads, so `streamHandler` is the wrapped handler there;
// elsewhere it's `undefined` and simply unused.
export const streamHandler =
  typeof (globalThis as { awslambda?: unknown }).awslambda !== "undefined"
    ? streamHandle(app)
    : undefined;
