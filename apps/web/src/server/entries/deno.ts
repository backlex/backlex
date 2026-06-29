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
import { serveStatic } from "hono/deno";
import { createApp } from "../app";
import { isDenoDeploy } from "../lib/runtime";
import { mountSpa } from "../lib/spa";
// `setInterval`-based scheduler (self-host) + the single idempotent tick the
// managed `Deno.cron` path reuses.
import { cronTick, startBunScheduler } from "../services/scheduler";
import { type Env, envFromSource } from "../env";

type DenoGlobal = {
  env: {
    get(key: string): string | undefined;
    toObject(): Record<string, string>;
  };
  serve: (opts: { port: number }, handler: (req: Request) => Response | Promise<Response>) => unknown;
  cron?: (
    name: string,
    schedule: string,
    handler: () => void | Promise<void>,
  ) => unknown;
};
const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
if (!deno) throw new Error("deno.ts entry must run on Deno");

const e = (key: string): string | undefined => deno.env.get(key);

const env: Env = {
  ...envFromSource(deno.env.toObject()),
  APP_URL: e("APP_URL") ?? "http://localhost:5173",
  AUTH_SECRET: e("AUTH_SECRET") ?? "dev-secret-change-me",
};

const app = createApp(env);
// Serve the pre-built admin SPA (dist/client) for non-API routes.
mountSpa(app, serveStatic);
const port = Number(e("PORT") ?? "8787");

// Wrap so Deno's second `ConnInfo` arg isn't passed as Hono's `env` binding.
deno.serve({ port }, (req) => app.fetch(req));
console.log(`backlex api listening on http://localhost:${port}`);

// Cron: on managed Deno Deploy a long-lived `setInterval` in a request-scoped
// isolate is unreliable, so drive the same idempotent tick via the native
// `Deno.cron` scheduler. On `deno run` self-host (no Deno Deploy / no
// `Deno.cron`) fall back to the `setInterval` scheduler like Bun/Node.
if (isDenoDeploy() && typeof deno.cron === "function") {
  deno.cron("backlex-cron", "* * * * *", () => cronTick(env));
} else {
  startBunScheduler(env);
}
