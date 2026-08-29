import { createApp } from "../app";
import { timingSafeEqual } from "../lib/timing";
import type { Env } from "../env";

/**
 * The scheduler reached lazily, from both of its two call sites below.
 *
 * `services/scheduler.ts` is the only thing in the worker that imports
 * `cron-parser`, and `cron-parser` is the only thing that imports `luxon` —
 * 260 KiB of date/timezone machinery that a cold isolate compiled before it
 * could answer a request, for a module reached only from a cron trigger and an
 * opt-in HTTP endpoint. Neither is on the request path.
 *
 * Both call sites were already async, so this costs nothing at either one. As
 * always, the `import()` is only half of it: `vite.config.ts::workerManualChunks`
 * needs the matching branch or `return "vendor"` pins cron-parser and luxon
 * back into the eager chunk regardless.
 */
const scheduler = () => import("../services/scheduler");

export { RealtimeRoom } from "../durable-objects/realtime-room";
export { RateLimitRoom } from "../durable-objects/rate-limit-room";

/**
 * HTTP cron endpoint, for a platform that runs this bundle but cannot give the
 * script a `scheduled()` trigger of its own.
 *
 * An ordinary Workers deploy never needs it — `wrangler.toml::triggers.crons`
 * drives `scheduled()` below, and this route stays closed because a self-hoster
 * has no reason to set CRON_SECRET. It exists for **Workers for Platforms**: a
 * user Worker in a dispatch namespace exports `scheduled()` but has no schedules
 * resource to register a cron against (the API answers a write there from the
 * script-upload handler), so nothing ever calls it. On such an instance the
 * handler is present and merely never invoked, which means no jobs, no scheduled
 * publish/unpublish, no auto-backups, no CDC, no cron flows and no integration
 * syncs — with nothing anywhere reporting a failure.
 *
 * Same contract as the Vercel/Netlify/Lambda/GCP entries: `x-cron-secret` or
 * `Authorization: Bearer`, compared in constant time, 401 otherwise. `cronTick`
 * is idempotent and deduped by `lastTickAt`, so an at-least-once caller is safe.
 * Opt-in by construction — with CRON_SECRET unset the endpoint is closed, so
 * this changes nothing for anyone who does not deliberately turn it on.
 */
export async function handleCronTick(request: Request, env: Env): Promise<Response> {
  const headerSecret = request.headers.get("x-cron-secret") ?? "";
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const provided = headerSecret || bearer;
  if (!env.CRON_SECRET || !provided || !timingSafeEqual(provided, env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  await (await scheduler()).cronTick(env);
  return Response.json({ ok: true, ts: Date.now() });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Answered ahead of the Hono app deliberately. The other entries register
    // this as `app.get(...)` because they build their app once at module scope;
    // here the app is constructed per request (env arrives with the request), so
    // registering a route would mutate the router on every call. The trade-off
    // is that this path does not inherit app middleware — acceptable because it
    // authenticates with its own shared secret rather than a session, and an
    // unauthenticated caller is rejected by a constant-time compare before any
    // database work happens.
    if (new URL(request.url).pathname === "/api/_cron/tick") {
      return handleCronTick(request, env);
    }
    const app = createApp(env);
    // Pass `ctx` through so `c.executionCtx.waitUntil` works — without it the
    // fire-and-forget tasks in keepAlive (5xx audit rows, opt-in cloud error /
    // AI usage reports) get cancelled when the response returns.
    return app.fetch(request, env, ctx);
  },

  /**
   * Cloudflare Workers cron handler — wired via `wrangler.toml::triggers.crons`.
   * Each cron invocation is a separate request; we delegate to the same
   * `cronTick` the Bun scheduler uses, with the cron event's scheduled time
   * as `now` so tracking is consistent across replicas.
   */
  async scheduled(
    event: { scheduledTime: number },
    env: Env,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ) {
    ctx.waitUntil(
      scheduler().then((m) => m.cronTick(env, new Date(event.scheduledTime))),
    );
  },
};
