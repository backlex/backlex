import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import type { Env } from "../env";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { resolvePermission } from "../services/permissions";
import {
  currentSeq,
  joinPresence,
  publishLocal,
  replayLocal,
  subscribeLocal,
  type ItemEventPayload,
  type SubscriptionMeta,
} from "../services/events";
import { rateLimitOk } from "../lib/rate-limit";
import { isStatelessEdge } from "../lib/runtime";

const ITEMS_PREFIX = "items:";
const PRESENCE_PREFIX = "presence:";
/** Comment-frame keep-alive so idle SSE connections survive proxy timeouts. */
const HEARTBEAT_MS = 25_000;
/** Hint the browser's EventSource reconnect delay (ms). */
const RECONNECT_HINT_MS = 3_000;
/** Backpressure bound for the in-process SSE outbound queue. A slow or dead
 *  client whose stream can't drain as fast as a publisher fills it would
 *  otherwise let the queue grow without limit → unbounded memory.
 *
 *  Policy: DISCONNECT the slow consumer rather than drop-oldest. Drop-oldest
 *  would silently punch gaps into the stream that the client never learns
 *  about; disconnecting triggers the browser's EventSource auto-reconnect,
 *  and the `Last-Event-ID` resume path replays the missed [since, snapshot]
 *  range — so the client recovers the gap cleanly instead of losing events.
 *  Slow consumers must not keep accumulating resources. */
const SSE_QUEUE_MAX = 1_000;
/** Free-form publish budget per (channel, client) in a 10s window. */
const PUBLISH_RATE_MAX = 30;
const PUBLISH_RATE_WINDOW_MS = 10_000;
const ITEM_EVENTS = new Set<ItemEventPayload["event"]>(["created", "updated", "deleted"]);

interface Gate {
  meta?: SubscriptionMeta;
  /** true for `presence:*` channels — the subscribe handler joins the roster. */
  presence?: boolean;
}

const clientIp = (c: { req: { header: (n: string) => string | undefined } }): string =>
  c.req.header("cf-connecting-ip") ??
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  "local";

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
  if (channel.startsWith(PRESENCE_PREFIX)) {
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "presence:* channels broadcast the roster automatically; client publish is disabled",
      );
    }
    if (!auth.userId) {
      throw new AppError("UNAUTHORIZED", "Sign in required for presence channels");
    }
    return {
      meta: { authSubject: auth, conditions: null, fields: null },
      presence: true,
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

/** Enqueue `item` onto a bounded SSE outbound `queue`. Returns `false` when the
 *  queue is already at `SSE_QUEUE_MAX` — the caller must then tear the
 *  subscriber down (slow/dead consumer). The item is NOT enqueued in that case,
 *  so the queue never exceeds the cap. */
const boundedEnqueue = (
  queue: QueueItem[],
  channel: string,
  item: QueueItem,
): boolean => {
  if (queue.length >= SSE_QUEUE_MAX) {
    console.warn(
      `[realtime] SSE queue overflow on "${channel}" (>= ${SSE_QUEUE_MAX}); ` +
        "disconnecting slow consumer — it can reconnect and replay via Last-Event-ID",
    );
    return false;
  }
  queue.push(item);
  return true;
};

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

const publishToChannel = async (
  env: Env,
  channel: string,
  payload: unknown,
): Promise<void> => {
  if (env.REALTIME) {
    const stub = env.REALTIME.get(env.REALTIME.idFromName(channel));
    await stub.fetch("https://do/publish", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } else if (isStatelessEdge()) {
    // Vercel Edge / Netlify Edge: every invocation is a fresh isolate, so
    // module-level subscribers from `publishLocal` would never see the
    // publish. Deploy to Cloudflare Workers (with REALTIME DO binding) or
    // Bun self-host for realtime.
    throw new AppError(
      "UNAVAILABLE",
      "Realtime is not available on Vercel Edge / Netlify Edge — deploy to Cloudflare Workers (with REALTIME Durable Object binding) or Bun.",
    );
  } else {
    publishLocal(channel, payload);
  }
};

const TestPublishInput = z
  .object({
    event: z.enum(["created", "updated", "deleted"]),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("RealtimeTestPublishInput");

const TAG = "realtime";

export const realtimeRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "post",
      path: "/{channel}/publish",
      tags: [TAG],
      summary: "Publish to a free-form channel",
      description:
        "Free-form channels only — `items:*`, `collections`, and `presence:*` are managed by the API and reject client publish. Rate limited per `(channel, ip)`.",
      security: SECURITY,
      request: {
        params: z.object({ channel: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.unknown().openapi({
                description: "Free-form payload — forwarded to every subscriber as-is.",
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Published",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { channel } = c.req.valid("param");
      await gateForChannel(ctx, auth, channel, true);

      if (!(await rateLimitOk(ctx.env, `pub:${channel}:${clientIp(c)}`, PUBLISH_RATE_MAX, PUBLISH_RATE_WINDOW_MS))) {
        throw new AppError("RATE_LIMITED", "Too many publishes — slow down");
      }
      const payload = await c.req.json();
      await publishToChannel(ctx.env, channel, payload);
      return c.json({ ok: true });
    },
  )
  // Admin-only synthetic event injector — lets you fire a fake ItemEvent at an
  // `items:*` channel to verify per-subscriber permission filtering / field
  // projection without performing real CRUD. No webhook/flow side effects.
  .openapi(
    createRoute({
      method: "post",
      path: "/{channel}/test-publish",
      tags: [TAG],
      summary: "Admin-only synthetic event injector",
      description:
        "Fires a synthetic `ItemEventPayload` at an `items:*` channel to verify per-subscriber permission filtering. No webhook/flow side effects.",
      security: SECURITY,
      request: {
        params: z.object({
          channel: z.string().openapi({ description: "Must start with `items:`." }),
        }),
        body: {
          required: true,
          content: { "application/json": { schema: TestPublishInput } },
        },
      },
      responses: {
        200: {
          description: "Injected",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const ctx = c.get("ctx");
      const { channel } = c.req.valid("param");
      if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
        throw new AppError(
          auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
          "Admin only",
        );
      }
      if (!channel.startsWith(ITEMS_PREFIX)) {
        throw new AppError("VALIDATION", "test-publish is only for items:* channels");
      }
      const body = c.req.valid("json") as { event: ItemEventPayload["event"]; data: Record<string, unknown> };
      if (typeof body.event !== "string" || !ITEM_EVENTS.has(body.event)) {
        throw new AppError("VALIDATION", "event must be one of created|updated|deleted");
      }
      if (body.data == null || typeof body.data !== "object" || Array.isArray(body.data)) {
        throw new AppError("VALIDATION", "data must be an object");
      }
      await publishToChannel(ctx.env, channel, {
        event: body.event,
        data: body.data,
      } satisfies ItemEventPayload);
      return c.json({ ok: true });
    },
  )
  // SSE subscribe — kept as a plain Hono `.get(...)` because the response is a
  // long-lived `text/event-stream`, not a JSON body suitable for OpenAPI
  // validation. The OpenAPI doc for this endpoint is registered separately by
  // `lib/openapi.ts` consumers if needed.
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
      if (gate.presence) url.searchParams.set("presence", "1");
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
        // Bounded enqueue: a slow SSE client can't outrun the DO WebSocket
        // feed forever — overflow flags the stream done so `pumpSSE` exits,
        // `finally` closes the upstream socket, and the client reconnects.
        const enqueue = (item: QueueItem) => {
          if (done) return;
          if (!boundedEnqueue(queue, channel, item)) {
            done = true;
          }
          wakeUp();
        };
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
          enqueue({ kind: "msg", id, data });
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
          enqueue({ kind: "ping" });
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

    // Stateless edges (Vercel Edge / Netlify Edge) lose subscribers between
    // invocations — the in-process `subscribeLocal` map doesn't survive. Bail
    // with a clear 503 instead of pretending the stream is live.
    if (isStatelessEdge()) {
      throw new AppError(
        "UNAVAILABLE",
        "Realtime is not available on Vercel Edge / Netlify Edge — deploy to Cloudflare Workers (with REALTIME Durable Object binding) or Bun.",
      );
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
      let aborted = false;
      // Bounded enqueue: if the outbound queue is full the consumer can't keep
      // up — flag the stream done so `pumpSSE` exits and `finally` unsubscribes.
      const enqueue = (item: QueueItem) => {
        if (aborted) return;
        if (!boundedEnqueue(queue, channel, item)) {
          aborted = true;
        }
        wakeUp();
      };
      const sub = {
        send: (msg: string, id?: number) => {
          enqueue({ kind: "msg", id, data: msg });
        },
        meta: gate.meta,
      };
      const unsub = subscribeLocal(channel, sub);
      // Snapshot the sequence at subscribe time: events with id <= this were
      // recorded before we joined the fan-out set, so replay [since, snapshot]
      // exactly fills the gap without duplicating anything delivered live.
      const snapshot = currentSeq(channel);
      c.req.raw.signal.addEventListener("abort", () => {
        aborted = true;
        wakeUp();
      });
      const hb = setInterval(() => {
        enqueue({ kind: "ping" });
      }, HEARTBEAT_MS);
      if (since > 0 && since < snapshot) replayLocal(channel, sub, since, snapshot);
      const leavePresence =
        gate.presence && gate.meta?.authSubject.userId
          ? joinPresence(channel, sub, {
              userId: gate.meta.authSubject.userId,
              email: gate.meta.authSubject.email ?? null,
            })
          : null;
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
        leavePresence?.();
        unsub();
      }
    });
  });
