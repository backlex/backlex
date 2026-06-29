import { serveStatic } from "hono/bun";
import { createApp } from "../app";
import { mountSpa } from "../lib/spa";
import { startBunScheduler } from "../services/scheduler";
import { type Env, envFromSource } from "../env";

// Map EVERY env knob (SMTP/SES/push/SMS/SSRF/OWNER_EMAIL/AI/etc.) from
// process.env via the shared helper, then apply the local dev fallbacks the
// required fields need so a bare `bun run` still boots.
const env: Env = {
  ...envFromSource(process.env),
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
};

const app = createApp(env);
// Serve the pre-built admin SPA (dist/client) for non-API routes.
mountSpa(app, serveStatic);
const port = Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`backlex api listening on ${server.url.href}`);

startBunScheduler(env);
