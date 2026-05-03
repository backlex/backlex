import { createApp } from "./app";
import type { Env } from "./env";

export { RealtimeRoom } from "./durable-objects/realtime-room";

export default {
  fetch(request: Request, env: Env, _ctx: unknown) {
    const app = createApp(env);
    return app.fetch(request, env);
  },
};
