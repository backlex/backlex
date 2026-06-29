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
import { fileURLToPath } from "node:url";
import { http } from "@google-cloud/functions-framework";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
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

// Serve the pre-built admin SPA. `build-gcp.ts` copies `dist/client` next to the
// bundle (→ `dist/gcp/client`); the root resolves relative to this module.
// Mounted AFTER every /api route, so the API wins and unmatched GETs fall
// through to the SPA shell. Must run BEFORE getRequestListener below, which
// snapshots `app.fetch`. (Front with Cloud CDN in production — see deployment.md.)
mountSpa(app, serveStatic, fileURLToPath(new URL("./client", import.meta.url)));

// The Node `(req, res)` listener Hono produces from `app.fetch` — exactly what
// the Functions Framework invokes per request. Exported so a plain Node HTTP
// server (the runtime-smoke host) can mount the identical listener without the
// framework CLI.
export const nodeListener = getRequestListener(app.fetch);

// Register the HTTP function. Deploy with `--entry-point=api`.
http("api", nodeListener);
