import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { AppBindings } from "../app";
import { resolvePermission } from "../services/permissions";
import {
  currentSeq,
  publishLocal,
  replayLocal,
  subscribeLocal,
  type SubscriptionMeta,
} from "../services/events";

const ITEMS_PREFIX = "items:";
/** Comment-frame keep-alive so idle SSE connections survive proxy timeouts. */
const HEARTBEAT_MS = 25_000;
/** Hint the browser's EventSource reconnect delay (ms). */
const RECONNECT_HINT_MS = 3_000;

interface Gate {
  meta?: SubscriptionMeta;
}

const gateForChannel = async (
  ctx: Parameters<typeof resolvePermission>[0] & { dialect: "pg" | "sqlite" },
  auth: { userId: string | null; email: string | null; roles: string[] },
  channel: string,
  isPublish: boolean,
): Promise<Gate> => {
  if (channel.startsWith(ITEMS_PREFIX)) {
    const slug = channel.slice(ITEMS_PREFIX.length);
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "items:* channels are published by the API; client publish is disabled",
      );
    }
    const perm = await resolvePermission(ctx, auth, slug, "read");
    if (!perm.allowed) {
      throw new AppError(
        auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
        auth.userId
          ? `No read permission for ${slug}`
          : "Sign in required",
      );
    }
    return {
      meta: {
        authSubject: auth,
        conditions: perm.isAdmin ? null : perm.conditions,
        fields: perm.fields ? [...perm.fields] : null,
      },
    };
  }
  if (channel === "collections") {
    if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
      throw new AppError(
        auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
        "Admin only",
      );
    }
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "collections channel is published by the API",
      );
    }
    return {
      meta: { authSubject: auth, conditions: null, fields: null },
    };
  }
  // user-defined channel: no auth, no filter
  return {};
};

/** Parse a `Last-Event-ID` header into a positive sequence number, or 0. */
const parseSince = (raw: string | undefined): number => {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

type QueueItem =
  | { kind: "msg"; id?: number; data: string }
  | { kind: "ping" };

/** Drain `queue` to the SSE stream until `isDone()` flips, parking on `setWake`
 *  between flushes. Shared by the Bun (in-process) and Workers (DO-bridge)
 *  subscribe paths. */
const pumpSSE = async (
  stream: SSEStreamingApi,
  channel: string,
  queue: QueueItem[],
  isDone: () => boolean,
  setWake: (resolve: (() => void) | null) => void,
): Promise<void> => {
  await stream.writeSSE({ event: "ready", data: channel, retry: RECONNECT_HINT_MS });
  while (!isDone()) {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.kind === "ping") {
        // SSE comment frame — keeps proxies from reaping an idle connection,
        // never surfaces to the EventSource client.
        await stream.write(": ping\n\n");
      } else {
        await stream.writeSSE({
          event: "message",
          data: item.data,
          id: item.id ? String(item.id) : undefined,
        });
      }
    }
    if (isDone()) break;
    await new Promise<void>((resolve) => setWake(resolve));
  }
};

export const realtimeRoutes = new Hono<AppBindings>()
  .post("/:channel/publish", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const channel = c.req.param("channel");
    await gateForChannel(ctx, auth, channel, true);

    const payload = await c.req.json();
    if (ctx.env.REALTIME) {
      const id = ctx.env.REALTIME.idFromName(channel);
      const stub = ctx.env.REALTIME.get(id);
      await stub.fetch("https://do/publish", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } else {
      publishLocal(channel, payload);
    }
    return c.json({ ok: true });
  })
  .get("/:channel/subscribe", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const channel = c.req.param("channel");
    const gate = await gateForChannel(ctx, auth, channel, false);
    const since = parseSince(c.req.header("Last-Event-ID"));

    // Workers: bridge a hibernatable WebSocket from the RealtimeRoom DO into an
    // SSE response so the EventSource client works the same on both runtimes.
    if (ctx.env.REALTIME) {
      const url = new URL("https://do/subscribe");
      if (gate.meta) url.searchParams.set("meta", btoa(JSON.stringify(gate.meta)));
      if (since > 0) url.searchParams.set("since", String(since));
      const id = ctx.env.REALTIME.idFromName(channel);
      const stub = ctx.env.REALTIME.get(id);
      const upstream = await stub.fetch(url.toString(), {
        headers: { upgrade: "websocket" },
      });
      const ws = upstream.webSocket;
      if (!ws) throw new AppError("INTERNAL", "realtime room did not upgrade");

      return streamSSE(c, async (stream) => {
        const queue: QueueItem[] = [];
        let wake: (() => void) | null = null;
        const wakeUp = () => {
          if (wake) {
            wake();
            wake = null;
          }
        };
        let done = false;
        ws.addEventListener("message", (ev: MessageEvent) => {
          const raw = typeof ev.data === "string" ? ev.data : "";
          let id: number | undefined;
          let data = raw;
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (
              parsed &&
              typeof parsed === "object" &&
              "__seq" in parsed &&
              "msg" in parsed
            ) {
              const s = (parsed as { __seq: unknown }).__seq;
              if (typeof s === "number") id = s;
              data = String((parsed as { msg: unknown }).msg);
            }
          } catch {
            // not a wrapped frame; forward as-is
          }
          queue.push({ kind: "msg", id, data });
          wakeUp();
        });
        ws.addEventListener("close", () => {
          done = true;
          wakeUp();
        });
        ws.addEventListener("error", () => {
          done = true;
          wakeUp();
        });
        c.req.raw.signal.addEventListener("abort", () => {
          done = true;
          try {
            ws.close();
          } catch {
            // already closed
          }
          wakeUp();
        });
        const hb = setInterval(() => {
          queue.push({ kind: "ping" });
          wakeUp();
        }, HEARTBEAT_MS);
        // Accept only after listeners are wired so DO-side replay frames
        // (queued during the `/subscribe` fetch) aren't dispatched into the void.
        ws.accept();
        try {
          await pumpSSE(
            stream,
            channel,
            queue,
            () => done,
            (r) => {
              wake = r;
            },
          );
        } finally {
          clearInterval(hb);
          try {
            ws.close();
          } catch {
            // already closed
          }
        }
      });
    }

    // Bun / self-host: in-process pub/sub straight onto an SSE stream.
    return streamSSE(c, async (stream) => {
      const queue: QueueItem[] = [];
      let wake: (() => void) | null = null;
      const wakeUp = () => {
        if (wake) {
          wake();
          wake = null;
        }
      };
      const sub = {
        send: (msg: string, id?: number) => {
          queue.push({ kind: "msg", id, data: msg });
          wakeUp();
        },
        meta: gate.meta,
      };
      const unsub = subscribeLocal(channel, sub);
      // Snapshot the sequence at subscribe time: events with id <= this were
      // recorded before we joined the fan-out set, so replay [since, snapshot]
      // exactly fills the gap without duplicating anything delivered live.
      const snapshot = currentSeq(channel);
      let aborted = false;
      c.req.raw.signal.addEventListener("abort", () => {
        aborted = true;
        wakeUp();
      });
      const hb = setInterval(() => {
        queue.push({ kind: "ping" });
        wakeUp();
      }, HEARTBEAT_MS);
      if (since > 0 && since < snapshot) replayLocal(channel, sub, since, snapshot);
      try {
        await pumpSSE(
          stream,
          channel,
          queue,
          () => aborted,
          (r) => {
            wake = r;
          },
        );
      } finally {
        clearInterval(hb);
        unsub();
      }
    });
  });
