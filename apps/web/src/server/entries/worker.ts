import { createApp } from "../app";
import { cronTick } from "../services/scheduler";
import type { Env } from "../env";

export { RealtimeRoom } from "../durable-objects/realtime-room";
export { RateLimitRoom } from "../durable-objects/rate-limit-room";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
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
    ctx.waitUntil(cronTick(env, new Date(event.scheduledTime)));
  },
};
