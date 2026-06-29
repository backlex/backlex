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
import { type Env, envFromSource } from "../env";

const denoEnv = (key: string): string | undefined => {
  const d = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  return d?.env.get(key) ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key];
};

// Merge whichever env source this isolate exposes (Netlify Node functions use
// process.env; the experimental Deno path uses Deno.env) into one record the
// shared mapper can read.
const envSource = (): Record<string, string | undefined> => {
  const d = (globalThis as { Deno?: { env: { toObject(): Record<string, string> } } }).Deno;
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return d ? { ...p, ...d.env.toObject() } : p;
};

const buildEnv = (): Env => ({
  ...envFromSource(envSource()),
  APP_URL: denoEnv("APP_URL") ?? "http://localhost:5173",
  AUTH_SECRET: denoEnv("AUTH_SECRET") ?? "dev-secret-change-me",
  // Netlify injects the site URL as `URL`; fall back to it for the executor
  // RPC callback origin.
  SELF_URL: denoEnv("SELF_URL") ?? denoEnv("URL"),
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
