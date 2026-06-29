/**
 * Azure Functions (v4 Node programming model) entry — the Azure counterpart of
 * `vercel.ts` / `lambda.ts` / `gcp.ts`. Azure has no official Hono adapter, so
 * a small shim bridges Azure's `HttpRequest`/`HttpResponseInit` (both already
 * Fetch-shaped — `request.url`, `request.headers: Headers`, `request.body:
 * ReadableStream`) to the runtime-agnostic Hono app: build a Web-standard
 * `Request`, call `app.fetch`, and hand the `Response` back as an
 * `HttpResponseInit`.
 *
 * Two functions are registered at module load:
 *   - `api`  — an HTTP-triggered catch-all (`route: "{*path}"`) that fronts the
 *              whole surface. Azure prepends a `/api` route prefix by default,
 *              so with the default prefix this serves `/api/*`. To also serve
 *              `/health`, `/docs`, and the SPA from the same function, set
 *              `"extensions": { "http": { "routePrefix": "" } }` in `host.json`
 *              (the bundled host.json from `scripts/build-azure.ts` does this).
 *   - `cron` — a **Timer trigger** (every minute) that calls the shared,
 *              idempotent `cronTick` directly. No HTTP cron route / shared
 *              secret needed on Azure: Timer triggers aren't publicly reachable.
 *
 * Built into a single-file bundle by `scripts/build-azure.ts`
 * (`apps/web/dist/azure/index.mjs` + `host.json` + a `package.json` whose `main`
 * points at it). `@azure/functions` is left EXTERNAL — the Azure runtime
 * provides it, and `app.http()/app.timer()` must register on the runtime's own
 * instance, not a second bundled copy.
 *
 * Runtime constraints (Azure Functions, Node 22 — same shape as the
 * Vercel/Netlify Node functions):
 *   - DB: no `bun:sqlite` → **Postgres** (`DATABASE_URL`); `neon-http` avoids a
 *     cold-start TCP handshake. libSQL/Turso also works.
 *   - Storage: the instance fs is ephemeral → set `S3_BUCKET` +
 *     `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (`aws4fetch`; works against
 *     Azure Blob's S3-compatible endpoints or any S3).
 *   - Realtime: instances recycle / scale, so module-level pub/sub doesn't hold
 *     → set `UPSTASH_REDIS_REST_*`. The buffered shim doesn't stream SSE; rely
 *     on the Upstash long-poll transport.
 *   - SAML, LDAP, SMTP all work (Node 22 raw TCP).
 *   - Image transforms run through `sharp` (native addon resolves at runtime).
 */
import { fileURLToPath } from "node:url";
import { app as azureApp, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "../app";
import { mountSpa } from "../lib/spa";
import { cronTick } from "../services/scheduler";
import { type Env, envFromSource } from "../env";

const buildEnv = (): Env => ({
  ...envFromSource(process.env),
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
});

const honoApp = createApp(buildEnv());

// Serve the pre-built admin SPA. `build-azure.ts` copies `dist/client` next to
// the bundle (→ `dist/azure/client`); the root resolves relative to this
// module. The catch-all `{*path}` route + cleared routePrefix mean the SPA is
// reachable at `/`, `/login`, etc. Mounted AFTER every /api route so the API
// wins. (Front with a CDN / Azure Static Web Apps in production — see
// deployment.md.)
mountSpa(honoApp, serveStatic, fileURLToPath(new URL("./client", import.meta.url)));

// Azure `HttpRequest` → Web-standard `Request`. Body is buffered to an
// ArrayBuffer (rather than streamed with `duplex: "half"`) for portability
// across Node/undici versions; Azure buffers the request anyway. GET/HEAD have
// no body.
const toRequest = async (request: HttpRequest): Promise<Request> => {
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(request.url, {
    method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
  });
};

azureApp.http("api", {
  // Catch every method; the Hono app does its own routing + 405s.
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  authLevel: "anonymous",
  // Catch-all — the app routes off the full `request.url`, so the wildcard
  // value itself is unused; it just needs to match every path.
  route: "{*path}",
  handler: async (request): Promise<HttpResponseInit> => {
    const res = await honoApp.fetch(await toRequest(request));
    // Buffer the response body to an ArrayBuffer. Hono's `Response.body` is the
    // DOM `ReadableStream`, which isn't the `node:stream/web` `ReadableStream`
    // Azure's `HttpResponseBodyInit` expects; buffering sidesteps the lib
    // mismatch and is fine here — Azure realtime uses Upstash long-poll (whole
    // HTTP responses), not streamed SSE, and storage downloads 302-redirect.
    return {
      status: res.status,
      headers: res.headers, // `Headers` is a valid `HttpHeadersInit`
      body: await res.arrayBuffer(),
    };
  },
});

// Timer trigger — replaces the `setInterval` scheduler. ncrontab format is
// `{sec} {min} {hour} {day} {month} {dow}`; this fires at second 0 every minute.
// cronTick is idempotent + deduped, so a missed/duplicated tick is harmless.
azureApp.timer("cron", {
  schedule: "0 * * * * *",
  handler: async () => {
    await cronTick(buildEnv());
  },
});
