/**
 * Deno self-host entry (experimental). Runs the same Hono app on Deno via
 * `Deno.serve`. Bundled by `scripts/build-deno.ts` into `dist/deno/server.mjs`
 * (Bun inlines the workspace/npm graph so Deno doesn't have to resolve the
 * monorepo's `node_modules/.bun` store — the issue that ruled out Netlify Edge),
 * then `deno run --allow-all apps/web/dist/deno/server.mjs`.
 *
 * Runtime notes for Deno:
 *   - DB     → Postgres (`DATABASE_URL`); `neon-http` recommended. No
 *              `bun:sqlite` (aliased to the shim at build); use libSQL for SQLite.
 *   - Sandbox→ QuickJS-WASM (WASM runs on Deno; `isBun()` is false).
 *   - Image  → `sharp` is a native addon and typically WON'T load on Deno, so
 *              the adapter degrades to passthrough (transforms return 422). Use
 *              a public-origin CDN path or Bun/Node/Workers if you need them.
 *   - Storage→ local fs (`node:fs` compat) or S3/R2 (`aws4fetch`).
 *   - Realtime → in-process SSE (single instance) or Upstash Redis.
 *   - Email  → SMTP (`nodemailer`, via Deno's node:net compat) or HTTP providers.
 */
import { createApp } from "../app";
// `setInterval`-based — runtime-agnostic despite the name.
import { startBunScheduler } from "../services/scheduler";
import type { Env } from "../env";

type DenoGlobal = {
  env: { get(key: string): string | undefined };
  serve: (opts: { port: number }, handler: (req: Request) => Response | Promise<Response>) => unknown;
};
const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
if (!deno) throw new Error("deno.ts entry must run on Deno");

const e = (key: string): string | undefined => deno.env.get(key);

const env: Env = {
  APP_URL: e("APP_URL") ?? "http://localhost:5173",
  AUTH_SECRET: e("AUTH_SECRET") ?? "dev-secret-change-me",
  DATABASE_URL: e("DATABASE_URL"),
  DATABASE_DRIVER: e("DATABASE_DRIVER") as Env["DATABASE_DRIVER"],
  LIBSQL_URL: e("LIBSQL_URL"),
  LIBSQL_AUTH_TOKEN: e("LIBSQL_AUTH_TOKEN"),
  OPENAI_API_KEY: e("OPENAI_API_KEY"),
  RESEND_API_KEY: e("RESEND_API_KEY"),
  EMAIL_FROM: e("EMAIL_FROM"),
  OAUTH_GOOGLE_CLIENT_ID: e("OAUTH_GOOGLE_CLIENT_ID"),
  OAUTH_GOOGLE_CLIENT_SECRET: e("OAUTH_GOOGLE_CLIENT_SECRET"),
  OAUTH_GITHUB_CLIENT_ID: e("OAUTH_GITHUB_CLIENT_ID"),
  OAUTH_GITHUB_CLIENT_SECRET: e("OAUTH_GITHUB_CLIENT_SECRET"),
  OAUTH_APPLE_CLIENT_ID: e("OAUTH_APPLE_CLIENT_ID"),
  OAUTH_APPLE_CLIENT_SECRET: e("OAUTH_APPLE_CLIENT_SECRET"),
  AUTH_PLUGINS: e("AUTH_PLUGINS"),
  EXTRA_TRUSTED_ORIGINS: e("EXTRA_TRUSTED_ORIGINS"),
  FUNCTIONS_FETCH_ALLOW: e("FUNCTIONS_FETCH_ALLOW"),
  FUNCTIONS_EXEC_URL: e("FUNCTIONS_EXEC_URL"),
  SANDBOX_RPC_TOKEN: e("SANDBOX_RPC_TOKEN"),
  SELF_URL: e("SELF_URL"),
  CRON_SECRET: e("CRON_SECRET"),
  S3_BUCKET: e("S3_BUCKET"),
  S3_REGION: e("S3_REGION"),
  S3_ENDPOINT: e("S3_ENDPOINT"),
  S3_ACCESS_KEY_ID: e("S3_ACCESS_KEY_ID"),
  S3_SECRET_ACCESS_KEY: e("S3_SECRET_ACCESS_KEY"),
  UPSTASH_REDIS_REST_URL: e("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: e("UPSTASH_REDIS_REST_TOKEN"),
  R2_PUBLIC_BASE: e("R2_PUBLIC_BASE"),
};

const app = createApp(env);
const port = Number(e("PORT") ?? "8787");

// Wrap so Deno's second `ConnInfo` arg isn't passed as Hono's `env` binding.
deno.serve({ port }, (req) => app.fetch(req));
console.log(`backlex api listening on http://localhost:${port}`);

startBunScheduler(env);
