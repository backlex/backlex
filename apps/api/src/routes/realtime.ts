import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppBindings } from "../app";

/**
 * In-process pub/sub used by the Bun entry. The Worker entry overrides
 * /:channel/subscribe to forward to the Durable Object instead.
 */
type Listener = (data: unknown) => void;
const subscribers = new Map<string, Set<Listener>>();

const subscribe = (channel: string, fn: Listener) => {
  let set = subscribers.get(channel);
  if (!set) {
    set = new Set();
    subscribers.set(channel, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
};

const publish = (channel: string, data: unknown) => {
  const set = subscribers.get(channel);
  if (!set) return;
  for (const fn of set) fn(data);
};

export const realtimeRoutes = new Hono<AppBindings>()
  .post("/:channel/publish", async (c) => {
    const { env } = c.get("ctx");
    const channel = c.req.param("channel");
    const payload = await c.req.json();

    if (env.REALTIME) {
      const id = env.REALTIME.idFromName(channel);
      const stub = env.REALTIME.get(id);
      await stub.fetch("https://do/publish", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } else {
      publish(channel, payload);
    }
    return c.json({ ok: true });
  })
  .get("/:channel/subscribe", async (c) => {
    const { env } = c.get("ctx");
    const channel = c.req.param("channel");

    if (env.REALTIME) {
      const id = env.REALTIME.idFromName(channel);
      const stub = env.REALTIME.get(id);
      return stub.fetch("https://do/subscribe", {
        headers: { upgrade: "websocket" },
      });
    }

    return streamSSE(c, async (stream) => {
      const unsub = subscribe(channel, (data) => {
        void stream.writeSSE({ event: "message", data: JSON.stringify(data) });
      });
      await stream.writeSSE({ event: "ready", data: channel });
      // keep open until client disconnects
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => {
          unsub();
          resolve();
        });
      });
    });
  });
