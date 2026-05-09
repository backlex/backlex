import { createApp } from "../app";
import { cronTick } from "../services/scheduler";
import type { Env } from "../env";

export { RealtimeRoom } from "../durable-objects/realtime-room";

export default {
  fetch(request: Request, env: Env, _ctx: unknown) {
    const app = createApp(env);
    return app.fetch(request, env);
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
