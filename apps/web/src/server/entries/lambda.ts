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
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { handle, streamHandle } from "hono/aws-lambda";
import { timingSafeEqual } from "../lib/timing";
import { createApp } from "../app";
import { mountSpa } from "../lib/spa";
import { cronTick } from "../services/scheduler";
import { type Env, envFromSource } from "../env";

const buildEnv = (): Env => ({
  ...envFromSource(process.env),
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
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

// Serve the pre-built admin SPA. `build-lambda.ts` copies `dist/client` next to
// the bundle (→ `dist/lambda/client`), so the static root resolves relative to
// this module regardless of the Lambda CWD. Reads from the function's
// filesystem (/var/task) via @hono/node-server's fs serveStatic; mountSpa adds
// it AFTER every /api route, so the API always wins and only unmatched GETs
// fall through to the SPA shell. (For CDN-cached assets in production, front the
// function with CloudFront over an S3 copy of dist/client — see deployment.md.)
mountSpa(app, serveStatic, fileURLToPath(new URL("./client", import.meta.url)));

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
