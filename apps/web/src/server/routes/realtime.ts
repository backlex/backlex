import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import type { Context as HonoContext } from "hono";
import { AppError, SYSTEM_ROLES, type Condition, normalizeCondition } from "@backlex/core";
import type { AppBindings } from "../app";
import type { Ctx } from "../context";
import type { Env } from "../env";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { resolvePermission } from "../services/permissions";
import {
  loadCollection,
  type CollectionRow,
} from "../services/items/collection-loader";
import {
  currentSeq,
  joinPresence,
  publishLocal,
  renderEventForMeta,
  replayLocal,
  subscribeLocal,
  type ItemEventPayload,
  type SubscriptionMeta,
} from "../services/events";
import {
  redisLatestId,
  redisPublish,
  redisRealtimeEnabled,
  redisReadSince,
} from "../services/realtime-redis";
import { rateLimitOk } from "../lib/rate-limit";
import { isStatelessEdge } from "../lib/runtime";
import {
  COLLAB_PREFIX,
  CollabPublishSchema,
  buildCollabMessage,
  collabConfig,
  mintAblyTokenRequest,
  parseCollabChannel,
} from "../services/collab";

/** Poll interval for the Redis-Stream subscribe loop (serverless transport). */
const REDIS_POLL_MS = 1_000;
/** Max time a single serverless long-poll holds before closing so the client's
 *  EventSource reconnects (Vercel: functions "should not subscribe to data
 *  events" / hold connections open). Well under the function execution limit. */
const REDIS_HOLD_MS = 20_000;

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
  /** true for `collab:*` channels — publish bodies are schema-validated and
   *  identity-stamped instead of forwarded as-is. */
  collab?: boolean;
}

const clientIp = (c: { req: { header: (n: string) => string | undefined } }): string =>
  c.req.header("cf-connecting-ip") ??
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  "local";

/** System columns a realtime filter may always reference (they're always
 *  projected to the subscriber, so filtering on them leaks nothing). */
const SYSTEM_FILTER_FIELDS = new Set([
  "id",
  "created_at",
  "updated_at",
  "owner_id",
  "_status",
  "_published_at",
  "_publish_at",
]);

/** Collect the (possibly dotted) leaf field names a normalized Condition
 *  references, so we can validate them against the caller's read allow-list. */
const collectConditionFields = (cond: Condition, out: Set<string>): void => {
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) {
    for (const x of c.$and) collectConditionFields(x as Condition, out);
    return;
  }
  if (Array.isArray(c.$or)) {
    for (const x of c.$or) collectConditionFields(x as Condition, out);
    return;
  }
  if (c.$not !== undefined) {
    collectConditionFields(c.$not as Condition, out);
    return;
  }
  for (const k of Object.keys(c)) out.add(k);
};

/**
 * Parse + validate a live-query `filter` for a realtime subscription. The
 * filter is evaluated IN-MEMORY against each event's flat row, so:
 *  - nested/relation (dotted) paths are rejected — there's no joined row to
 *    walk at emit time (the client refetches those, as today);
 *  - every referenced field must exist AND be readable by the caller —
 *    otherwise a subscriber could probe an unreadable column's value by
 *    observing which events its filter lets through.
 */
const parseRealtimeFilter = (
  filterRaw: string,
  collection: CollectionRow,
  permFields: Set<string> | null,
): Condition => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(filterRaw);
  } catch {
    throw new AppError("VALIDATION", "Invalid realtime `filter` JSON");
  }
  const relationFields = new Set(
    collection.fields
      .filter((f) => f.type === "relation" || f.type === "relation_many")
      .map((f) => f.name),
  );
  const cond = normalizeCondition(parsed, { relationFields });
  const refs = new Set<string>();
  collectConditionFields(cond, refs);
  const known = new Set(collection.fields.map((f) => f.name));
  for (const field of refs) {
    if (field.includes(".")) {
      throw new AppError(
        "VALIDATION",
        `Realtime filter can't use the nested path "${field}" — events carry a flat row; filter client-side for relations`,
      );
    }
    if (!known.has(field) && !SYSTEM_FILTER_FIELDS.has(field)) {
      throw new AppError("VALIDATION", `Unknown field in realtime filter: ${field}`);
    }
    if (permFields && !permFields.has(field) && !SYSTEM_FILTER_FIELDS.has(field)) {
      throw new AppError("FORBIDDEN", `No permission to filter on field: ${field}`);
    }
  }
  return cond;
};

const gateForChannel = async (
  ctx: Ctx,
  auth: { userId: string | null; email: string | null; roles: string[]; tenantId?: string | null },
  channel: string,
  isPublish: boolean,
  filterRaw?: string,
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
    let conditions: Condition[] | null = perm.isAdmin ? null : perm.conditions;
    // Load the collection once if we need it — for the versioned draft gate
    // (non-admin) and/or to validate a live-query filter.
    let collection: CollectionRow | null = null;
    if (auth.tenantId && (filterRaw || !perm.isAdmin)) {
      try {
        collection = await loadCollection(ctx, auth.tenantId, slug);
      } catch {
        collection = null;
      }
    }
    // Versioned collections: a subscriber without publish/update sees only
    // published items, so AND a `_status='published'` clause into every
    // permission condition (matched in-memory against each event's payload).
    if (!perm.isAdmin && collection?.versioned) {
      const canSeeDrafts =
        (await resolvePermission(ctx, auth, slug, "publish")).allowed ||
        (await resolvePermission(ctx, auth, slug, "update")).allowed;
      if (!canSeeDrafts) {
        const pub: Condition = { _status: { _eq: "published" } } as Condition;
        conditions =
          conditions && conditions.length
            ? conditions.map((c) => ({ _and: [c, pub] }) as Condition)
            : [pub];
      }
    }
    // Live-query filter (reactive Stage 1) — AND'd on top of the permission
    // conditions, narrowing what this subscriber receives.
    let queryFilter: Condition | null = null;
    if (filterRaw) {
      if (!collection) {
        throw new AppError("VALIDATION", "Realtime filter requires an active workspace");
      }
      queryFilter = parseRealtimeFilter(filterRaw, collection, perm.fields ?? null);
    }
    return {
      meta: {
        authSubject: auth,
        conditions,
        fields: perm.fields ? [...perm.fields] : null,
        queryFilter,
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
  if (channel.startsWith(COLLAB_PREFIX)) {
    // Collaboration channels: record-level presence + field awareness.
    // Both subscribe AND publish are open to any signed-in user who can READ
    // the collection — messages carry only non-sensitive metadata (user id,
    // email, field name), and identity is stamped server-side at publish.
    const parsed = parseCollabChannel(channel);
    if (!parsed) {
      throw new AppError("VALIDATION", "Malformed collab channel — expected collab:list:<slug> or collab:item:<slug>:<id>");
    }
    if (!auth.userId) {
      throw new AppError("UNAUTHORIZED", "Sign in required for collab channels");
    }
    const perm = await resolvePermission(ctx, auth, parsed.slug, "read");
    if (!perm.allowed) {
      throw new AppError("FORBIDDEN", `No read permission for ${parsed.slug}`);
    }
    return { collab: true };
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
  } else if (redisRealtimeEnabled(env)) {
    // Stateless serverless (Vercel / Netlify) with Upstash configured: fan out
    // through a Redis Stream so subscribers on other invocations see it.
    await redisPublish(env, channel, payload);
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
      const gate = await gateForChannel(ctx, auth, channel, true);

      if (!(await rateLimitOk(ctx.env, `pub:${channel}:${clientIp(c)}`, PUBLISH_RATE_MAX, PUBLISH_RATE_WINDOW_MS))) {
        throw new AppError("RATE_LIMITED", "Too many publishes — slow down");
      }
      let payload = await c.req.json();
      if (gate.collab) {
        // Collab channels never forward the raw body: validate the shape and
        // stamp identity + timestamp from the session so a member can't
        // impersonate another (the gate guarantees userId is set).
        const parsed = CollabPublishSchema.safeParse(payload);
        if (!parsed.success) {
          throw new AppError("VALIDATION", "Invalid collab message — expected { t, item?, field? }");
        }
        payload = buildCollabMessage(parsed.data, {
          userId: auth.userId!,
          email: auth.email,
        });
      }
      await publishToChannel(ctx.env, channel, payload);
      return c.json({ ok: true });
    },
  )
  // How the admin SPA should reach collab channels on this deployment —
  // `native` (SSE subscribe + REST publish work) or `off` (no viable
  // transport; the UI hides collab affordances). Phase 2 adds `ably`.
  .openapi(
    createRoute({
      method: "get",
      path: "/collab-config",
      tags: [TAG],
      summary: "Collaboration transport capability",
      security: SECURITY,
      responses: {
        200: {
          description: "Transport the client should use for collab channels",
          content: {
            "application/json": {
              schema: z
                .object({ transport: z.enum(["native", "ably", "off"]) })
                .openapi("CollabConfig"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    (c) => c.json(collabConfig(c.get("ctx").env)),
  )
  // Ably token auth for collab channels: the browser's ably-js authCallback
  // POSTs the channels it wants; each one passes the same permission gate as a
  // native subscribe, and the response is a TokenRequest whose capability is
  // scoped to exactly those channels with `clientId` pinned to the session
  // user (Ably then enforces the identity on every publish). The API key
  // secret never leaves the server.
  .openapi(
    createRoute({
      method: "post",
      path: "/collab-token",
      tags: [TAG],
      summary: "Mint an Ably TokenRequest scoped to collab channels",
      security: SECURITY,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({ channels: z.array(z.string()).min(1).max(10) })
                .openapi("CollabTokenInput"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Signed Ably TokenRequest for the requested channels",
          content: {
            "application/json": {
              schema: z
                .object({ tokenRequest: z.record(z.string(), z.unknown()) })
                .openapi("CollabTokenResponse"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!ctx.env.ABLY_API_KEY) {
        throw new AppError("UNAVAILABLE", "Ably is not configured on this deployment");
      }
      const { channels } = c.req.valid("json");
      for (const channel of channels) {
        if (!channel.startsWith(COLLAB_PREFIX)) {
          throw new AppError("VALIDATION", "collab-token only covers collab:* channels");
        }
        await gateForChannel(ctx, auth, channel, false);
      }
      const tokenRequest = await mintAblyTokenRequest(
        ctx.env.ABLY_API_KEY,
        auth.userId!,
        channels,
      );
      return c.json({ tokenRequest });
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
  .get("/:channel/subscribe", (c) =>
    openRealtimeSubscribe(c, c.req.param("channel"), c.req.query("filter")),
  );

/**
 * Open a permission-gated SSE subscription on `channel` for the calling
 * request, picking the right transport for the runtime (Workers DO bridge /
 * Redis-Stream long-poll / in-process bus). Exported so other streaming
 * surfaces (the GraphQL `/api/graphql/stream` subscription endpoint) reuse
 * the exact same gate + transports instead of reimplementing them.
 */
export const openRealtimeSubscribe = async (
  c: HonoContext<AppBindings>,
  channel: string,
  filterRaw: string | undefined,
): Promise<Response> => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    // Disable proxy buffering for the SSE stream. Without this, Vercel/Netlify
    // (and nginx-style proxies) buffer `text/event-stream` responses and only
    // flush when the function ends — frames never reach the client live. This
    // header tells the proxy to pass bytes through as they're written.
    c.header("X-Accel-Buffering", "no");
    // `?filter=<json>` opts a subscription into server-side narrowing: only
    // events whose row matches the filter (AND the caller's permission) are
    // delivered (reactive invalidation Stage 1).
    const gate = await gateForChannel(ctx, auth, channel, false, filterRaw);
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

    // Stateless serverless (Vercel / Netlify Functions) with Upstash Redis:
    // stream the channel's Redis Stream over SSE. Cross-instance fan-out +
    // `Last-Event-ID` replay come from the stream ids. Presence rosters need
    // shared mutable membership we don't track here, so presence channels still
    // fall through to the unsupported path below.
    if (redisRealtimeEnabled(ctx.env) && !gate.presence) {
      return streamSSE(c, async (stream) => {
        // Capture the resume position BEFORE announcing ready: resume from the
        // client's Last-Event-ID, else from "now" (the latest stream id) so a
        // fresh subscriber only sees future events. Capturing first means a
        // publish that lands between here and the first poll isn't skipped.
        const lastHeader = c.req.header("Last-Event-ID");
        let cursor =
          lastHeader && lastHeader.length > 0
            ? lastHeader
            : await redisLatestId(ctx.env, channel);
        await stream.writeSSE({ event: "ready", data: channel, retry: RECONNECT_HINT_MS });
        let aborted = false;
        c.req.raw.signal.addEventListener("abort", () => {
          aborted = true;
        });
        // Long-poll, not a held subscription: serverless functions must respond
        // quickly and not hold a stream open (Vercel guidance). Poll Redis for a
        // bounded window; the moment we deliver a batch, CLOSE so the proxy
        // flushes it and the browser's EventSource auto-reconnects with
        // Last-Event-ID to resume. An idle stream closes at REDIS_HOLD_MS and the
        // client reconnects. (Bun / Workers keep the held stream above.)
        const startedAt = Date.now();
        let delivered = false;
        while (!aborted && Date.now() - startedAt < REDIS_HOLD_MS) {
          let entries: Awaited<ReturnType<typeof redisReadSince>> = [];
          try {
            entries = await redisReadSince(ctx.env, channel, cursor);
          } catch {
            // transient REST hiccup — retry next tick
          }
          for (const entry of entries) {
            cursor = entry.id;
            // Same permission filter + field projection as the in-process path.
            const rendered = renderEventForMeta(gate.meta, entry.payload);
            if (rendered === null) continue;
            await stream.writeSSE({ event: "message", data: rendered, id: entry.id });
            delivered = true;
          }
          if (delivered || aborted) break;
          await new Promise((r) => setTimeout(r, REDIS_POLL_MS));
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
};
