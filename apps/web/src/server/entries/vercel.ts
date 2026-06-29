/**
 * Vercel Function entry. `scripts/build-vercel-output.ts` pre-bundles
 * `vercel-fn-entry.ts` (which imports the Hono app exported here) into
 * `.vercel/output/functions/api/index.func/index.mjs` and writes the
 * matching `.vc-config.json` + top-level `config.json` (which routes
 * every `/api/*` path through this single function — see
 * `vercel-fn-entry.ts` for the URL-reconstruction step that pulls the
 * original path back out of the rewrite query string).
 *
 * Deploys as a Node serverless function under Fluid Compute, pinned to
 * `nodejs22.x` by the function descriptor (`scripts/build-vercel-output.ts`).
 * Node keeps node:net/tls/crypto available, so SAML/LDAP/SMTP load.
 *
 * Runtime constraints:
 *   - DATABASE_URL is required. `DATABASE_DRIVER=neon-http` is still
 *     recommended (Vercel functions are short-lived; HTTP avoids the
 *     TCP handshake cost per cold start), and it's the path
 *     `buildContext` defaults to under `vercel` profile detection.
 *   - Storage: set `S3_BUCKET` + `S3_ACCESS_KEY_ID` +
 *     `S3_SECRET_ACCESS_KEY` so the adapter switches to S3. The
 *     function zip has no local fs to fall back on.
 *   - Realtime SSE loads but is impractical (Vercel functions are
 *     stateless, module-level pub/sub Maps don't share across
 *     invocations, and function execution time caps the SSE stream).
 *   - Cron triggers configured via `vercel.ts::crons` hit
 *     `/api/_cron/tick`. The route accepts EITHER `x-cron-secret:
 *     $CRON_SECRET` (manual callers) OR `Authorization: Bearer $CRON_SECRET`
 *     (what Vercel's cron sends automatically when CRON_SECRET is set as a
 *     project env var). Without a match the route 401s so the public
 *     internet can't trigger jobs.
 */
import { timingSafeEqual } from "../lib/timing";
import { createApp } from "../app";
import { cronTick } from "../services/scheduler";
import { type Env, envFromSource } from "../env";

const buildEnv = (): Env => ({
  ...envFromSource(process.env),
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
  // Vercel injects the deploy hostname as VERCEL_URL; fall back to it so the
  // executor RPC callback has an origin even when SELF_URL isn't set.
  SELF_URL: process.env.SELF_URL ?? process.env.VERCEL_URL,
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
// `.vercel/output/functions/api/index.func/index.mjs`) wraps it in the Web Standard `{ fetch(req) }`
// object literal Vercel's Node runtime requires for fetch-handler mode.
export default app;
