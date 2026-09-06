import type { AuthSubject, Condition, EmailAdapter } from "@backlex/core";
import {
  eventIsForSubscriber,
  type IncomingItemEvent,
  renderItemEvent,
  stripBefore,
} from "./realtime-filter";
import { type ChannelAddress, parseTopic, topicFor } from "./realtime-topic";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { Ctx } from "../context";
import type { Env } from "../env";
import { keepAliveCtx } from "./activity";
import { dispatchWebhooks } from "./webhooks";
import { dispatchIntegrations } from "./integrations";
import { runFlows } from "./flows";
import { runEventFunctions } from "./functions";
import { runExtensionEventHooks } from "./extensions";
import { redisPublish, redisRealtimeEnabled } from "./realtime-redis";
import {
  ablyPublishSignal,
  itemSignalFor,
  itemsTransportKind,
} from "./realtime-signal";

export interface ItemEventPayload {
  event: "created" | "updated" | "deleted";
  data: Record<string, unknown>;
  /** Pre-write row, set only on `updated` events. SERVER-ONLY — the emit
   *  chokepoint uses it to compute each filtered subscriber's membership
   *  transition (reactive Stage 2), then strips it; it never reaches a client. */
  before?: Record<string, unknown>;
}

export interface SubscriptionMeta {
  authSubject: AuthSubject;
  /** null = unrestricted (admin or unconditional permission). */
  conditions: Condition[] | null;
  /** null = all fields readable. */
  fields: string[] | null;
  /** Optional live-query filter (reactive invalidation Stage 1) — AND'd on top
   *  of the permission conditions so a filtered subscriber receives only the
   *  events whose row matches its query, evaluated server-side. */
  queryFilter?: Condition | null;
  /** Which store the in-memory predicate is standing in for — see
   *  {@link RealtimeFilter.dialect}. Frozen with the rest of the gate at
   *  subscribe time, because the Durable Object that evaluates it has no
   *  database binding to ask. */
  dialect?: "pg" | "sqlite";
}

export interface Subscriber {
  /** `id` is the monotonic per-channel sequence number for SSE `Last-Event-ID`
   *  resumption; `0` (or omitted) means the message is not replayable. */
  send: (msg: string, id?: number) => void;
  meta?: SubscriptionMeta;
  /**
   * The workspace this subscription was gated in — `auth.tenantId` frozen at
   * subscribe time, `null` for a caller with no active workspace.
   *
   * REQUIRED, and deliberately not on {@link SubscriptionMeta}: `collab:` and
   * application-owned channels are authorized without a meta, and those are
   * precisely the subscriptions whose payloads are forwarded raw. Required
   * rather than optional so a new subscription site cannot omit it and inherit
   * whatever the room happens to hold.
   */
  tenantId: string | null;
}

const isItemPayload = (payload: unknown): payload is ItemEventPayload =>
  typeof payload === "object" &&
  payload !== null &&
  "event" in payload &&
  "data" in payload;

/** Serialize `payload` for a single subscriber. For ItemEvent-shaped payloads
 *  with subscriber meta, this delegates to the shared `renderItemEvent`
 *  (permission gate + field projection + Stage-2 membership transitions); the
 *  server-only `before` is always stripped. Returns `null` to drop. */
const renderFor = (
  sub: Subscriber,
  payload: unknown,
  isItem: boolean,
  eventTenant: string | null | undefined,
): string | null => {
  if (!eventIsForSubscriber(eventTenant, sub.tenantId)) return null;
  if (sub.meta && isItem) {
    const out = renderItemEvent(payload as IncomingItemEvent, sub.meta);
    return out === null ? null : JSON.stringify(out);
  }
  // No meta (raw channel) — strip `before` defensively before forwarding.
  return JSON.stringify(isItem ? stripBefore(payload) : payload);
};

/**
 * Render a published `payload` for a subscriber identified only by its
 * `SubscriptionMeta` (no live `send`). Returns the JSON string to emit, or
 * `null` when the subscriber must not see this event. Reuses the exact same
 * permission filter + field projection as the in-process fan-out, so the
 * out-of-process transports (Redis on serverless) can't drift from it.
 */
export const renderEventForMeta = (
  meta: SubscriptionMeta | undefined,
  payload: unknown,
  /** The subscription's workspace, and the workspace the event was published
   *  in. Separate parameters because on the Redis path the two come from
   *  different places — the gate and the stream key — and a caller that could
   *  pass one for both would be asserting the thing being checked. */
  subscriberTenant: string | null,
  eventTenant: string | null,
): string | null =>
  renderFor(
    { send: () => {}, meta, tenantId: subscriberTenant },
    payload,
    isItemPayload(payload),
    eventTenant,
  );

/** Keyed by TOPIC (`realtime-topic.ts`), never by channel — two workspaces that
 *  own a collection of the same name must not share a room. */
const subscribers = new Map<string, Set<Subscriber>>();

/** Bounded per-channel ring buffer of recent events so a reconnecting SSE
 *  subscriber can replay anything it missed (via `Last-Event-ID`). */
interface RecentEntry {
  id: number;
  /** JSON.stringify of the raw published payload — re-rendered per subscriber
   *  on replay so the permission filter still applies. */
  raw: string;
}
const RECENT_LIMIT = 50;
const recent = new Map<string, { seq: number; entries: RecentEntry[] }>();

const recordRecent = (topic: string, payload: unknown): number => {
  let r = recent.get(topic);
  if (!r) {
    r = { seq: 0, entries: [] };
    recent.set(topic, r);
  }
  r.seq += 1;
  r.entries.push({ id: r.seq, raw: JSON.stringify(payload) });
  if (r.entries.length > RECENT_LIMIT) {
    r.entries.splice(0, r.entries.length - RECENT_LIMIT);
  }
  return r.seq;
};

/** Highest sequence number currently recorded for an address (0 if none). */
export const currentSeq = (addr: ChannelAddress): number =>
  recent.get(topicFor(addr))?.seq ?? 0;

/**
 * Read-only diagnostic snapshot of a channel's in-process state. Mirrors the
 * shape of the DO `/stats` endpoint so the admin route can return the same
 * payload regardless of runtime. Returns zeroes for an unknown channel.
 */
export interface ChannelStats {
  connectedSockets: number;
  presenceMembers: number;
  currentSeq: number;
  logSize: number;
}

export const getLocalChannelStats = (addr: ChannelAddress): ChannelStats => {
  const topic = topicFor(addr);
  const subs = subscribers.get(topic)?.size ?? 0;
  const room = presenceRooms.get(topic);
  // Presence rosters dedupe by userId — count unique members, not raw sockets.
  let presenceMembers = 0;
  if (room) {
    const ids = new Set<string>();
    for (const m of room.values()) ids.add(m.userId);
    presenceMembers = ids.size;
  }
  const r = recent.get(topic);
  return {
    connectedSockets: subs,
    presenceMembers,
    currentSeq: r?.seq ?? 0,
    logSize: r?.entries.length ?? 0,
  };
};

/** Channels of `tenantId` that currently have at least one in-process
 *  subscriber — the Bun-path answer to "which free-form channels are live"
 *  (on Workers there is no equivalent; DOs aren't enumerable).
 *
 *  Filtered by workspace, because the map holds every workspace's rooms and a
 *  caller is an admin of exactly one.
 *
 *  **No caller today.** `routes/realtime-admin.ts` enumerates from the
 *  `collections` table instead, so the comment that used to claim it as this
 *  function's consumer was wrong. Kept because it is the only way to see an
 *  application-owned channel that no table knows about, and corrected here
 *  rather than left as a false lead. */
export const listLocalChannels = (tenantId: string | null): string[] => {
  const out: string[] = [];
  for (const topic of subscribers.keys()) {
    const addr = parseTopic(topic);
    if (addr && addr.tenantId === tenantId) out.push(addr.channel);
  }
  return out;
};

export const subscribeLocal = (
  addr: ChannelAddress,
  sub: Subscriber,
): (() => void) => {
  const topic = topicFor(addr);
  let set = subscribers.get(topic);
  if (!set) {
    set = new Set();
    subscribers.set(topic, set);
  }
  set.add(sub);
  return () => {
    set!.delete(sub);
    if (set!.size === 0) subscribers.delete(topic);
  };
};

/** Replay events `after < id <= upTo` from the ring buffer to a single
 *  subscriber, applying its permission filter. */
export const replayLocal = (
  addr: ChannelAddress,
  sub: Subscriber,
  after: number,
  upTo: number,
): void => {
  const r = recent.get(topicFor(addr));
  if (!r) return;
  for (const e of r.entries) {
    if (e.id <= after || e.id > upTo) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(e.raw);
    } catch {
      payload = e.raw;
    }
    // Every entry in this ring buffer was published into THIS topic, so the
    // topic's own workspace is the publishing workspace — there is nothing
    // per-entry to store.
    const msg = renderFor(sub, payload, isItemPayload(payload), addr.tenantId);
    if (msg === null) continue;
    try {
      sub.send(msg, e.id);
    } catch {
      // ignore per-subscriber errors
    }
  }
};

export const publishLocal = (addr: ChannelAddress, payload: unknown): void => {
  const topic = topicFor(addr);
  const id = recordRecent(topic, payload);
  const set = subscribers.get(topic);
  if (!set) return;
  const isItem = isItemPayload(payload);
  for (const sub of set) {
    try {
      const msg = renderFor(sub, payload, isItem, addr.tenantId);
      if (msg !== null) sub.send(msg, id);
    } catch {
      // ignore per-subscriber errors
    }
  }
};

// --- Presence (in-process / Bun) -------------------------------------------

export interface PresenceMember {
  userId: string;
  email: string | null;
}

export interface PresencePayload {
  event: "presence";
  data: { members: PresenceMember[] };
}

/** Keyed by TOPIC, like every other room in this module. */
const presenceRooms = new Map<string, Map<Subscriber, PresenceMember>>();

const presenceMembers = (topic: string): PresenceMember[] => {
  const room = presenceRooms.get(topic);
  if (!room) return [];
  const byId = new Map<string, PresenceMember>();
  for (const m of room.values()) byId.set(m.userId, m);
  return [...byId.values()].sort((a, b) =>
    (a.email ?? a.userId).localeCompare(b.email ?? b.userId),
  );
};

const broadcastPresenceLocal = (addr: ChannelAddress): void => {
  publishLocal(addr, {
    event: "presence",
    data: { members: presenceMembers(topicFor(addr)) },
  } satisfies PresencePayload);
};

/** Register `sub` as a member of a `presence:*` channel and announce the
 *  updated roster. Returns a leave fn that deregisters + re-announces. */
export const joinPresence = (
  addr: ChannelAddress,
  sub: Subscriber,
  member: PresenceMember,
): (() => void) => {
  const topic = topicFor(addr);
  let room = presenceRooms.get(topic);
  if (!room) {
    room = new Map();
    presenceRooms.set(topic, room);
  }
  room.set(sub, member);
  broadcastPresenceLocal(addr);
  return () => {
    room!.delete(sub);
    if (room!.size === 0) presenceRooms.delete(topic);
    broadcastPresenceLocal(addr);
  };
};

/** The server-side half of {@link publishEvent}: webhooks, integrations, flows,
 *  event functions and extension hooks. See {@link dispatchEventHandlers}. */
export interface EventServerCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
  email?: EmailAdapter;
  fullCtx?: Ctx;
}

/**
 * How a fan-out promise survives the response, given whatever context the
 * publisher happened to have.
 *
 * `Ctx.waitUntil` is set by the request middleware and absent everywhere else
 * (cron ticks, queue consumers, the test harness), where the promise floats as
 * it always did. A handler that throws must not take down the write that
 * announced it, and it never could before either.
 */
const keepEventWork = (serverCtx: EventServerCtx): ((p: Promise<unknown>) => void) => {
  const holder = serverCtx.fullCtx ?? {};
  return (p: Promise<unknown>) => keepAliveCtx(holder, p, "events");
};

/**
 * Run every server-side handler for an event, WITHOUT putting it on the
 * realtime bus.
 *
 * {@link publishEvent} does both, and for item events that is right: the bus is
 * permission-filtered per subscriber (`renderItemEvent`), so a row only reaches
 * someone allowed to read it.
 *
 * A channel that is not item-shaped gets no such filter — `renderFor` forwards
 * a raw payload verbatim — and `gateForChannel` leaves unrecognised channel
 * names open to anyone, signed in or not. So an event whose payload carries
 * data that is nobody's business to subscribe to must reach its handlers
 * WITHOUT being broadcast. Bookings are the case this exists for: a booking
 * carries a customer's name, address and phone number, and it needs to trigger
 * a reminder flow, not to be readable by whoever opens an SSE stream.
 *
 * Kept beside `publishEvent` and called BY it, so there is one implementation
 * of the fan-out rather than two that drift.
 */
export const dispatchEventHandlers = (
  env: Env,
  addr: ChannelAddress,
  /**
   * Wider than {@link ItemEventPayload}, whose `event` is the three verbs a ROW
   * can undergo. Every consumer below matches on the event as a plain string
   * (`matchesTrigger`, `matchesPattern`), so a system channel is free to name
   * what actually happened — `confirmed`, `cancelled`, `no_show`. Narrowing
   * here would only force those callers to lie about their event.
   */
  evt: { event: string; data: Record<string, unknown>; before?: Record<string, unknown> },
  serverCtx: EventServerCtx,
): void => {
  // Every fan-out below is scoped with the ORIGINATING workspace, taken from
  // the address the caller published to — never re-derived from the payload.
  // It is the same value that keys the realtime room, so a handler and a
  // subscriber can never disagree about which workspace an event belongs to.
  const { tenantId, channel } = addr;
  // Every handler below is deliberately NOT awaited — a write must not pay for
  // its own webhooks — but "not awaited" and "cancelled" are different things.
  // On Workers the isolate is torn down once the response resolves, so a bare
  // `void` promise here means the webhook, the flow, the integration sync and
  // the event function are all silently dropped on the one deploy target this
  // repo ships to by default. `keep` hands each to `waitUntil` where the
  // request layer supplied one and floats it where it did not (cron, queues,
  // tests), which is exactly what every runtime did before.
  const keep = keepEventWork(serverCtx);
  // Pass the full Ctx when available so dispatch enqueues durable
  // webhook.deliver jobs (retry + dead-letter); otherwise it sends inline.
  keep(dispatchWebhooks(serverCtx.fullCtx ?? serverCtx, tenantId, channel, evt));
  keep(dispatchIntegrations(env, serverCtx, tenantId, channel, evt));
  if (serverCtx.fullCtx) {
    keep(runFlows(serverCtx.fullCtx, tenantId, channel, evt));
    keep(
      runEventFunctions(
        serverCtx.fullCtx,
        tenantId,
        channel,
        evt,
        // Functions triggered by events run with the system principal — admin
        // can toggle the function active flag for trust gating.
        { userId: null, email: null, roles: [], tenantId },
      ),
    );
    keep(
      runExtensionEventHooks(serverCtx.fullCtx, tenantId, channel, evt, {
        userId: null,
        email: null,
        roles: [],
        tenantId,
      }),
    );
  }
};

/**
 * Put an event on the realtime bus and run its server-side handlers.
 *
 * The address is a (workspace, channel) pair and BOTH halves are required —
 * that is the whole point of the parameter's shape. It used to be a bare
 * channel string with the workspace tucked into an OPTIONAL `serverCtx`, and
 * two call sites (the agent thread emitters) passed no context at all. A
 * publisher that omits its workspace does not fail loudly: it publishes into a
 * room nobody is listening in, so realtime goes quietly dark. Making the
 * workspace part of the address means the compiler asks the question at every
 * call site instead.
 */
export const publishEvent = async (
  env: Env,
  addr: ChannelAddress,
  payload: unknown,
  serverCtx?: EventServerCtx,
): Promise<void> => {
  const topic = topicFor(addr);
  if (env.REALTIME) {
    const id = env.REALTIME.idFromName(topic);
    const stub = env.REALTIME.get(id);
    await stub.fetch("https://do/publish", {
      method: "POST",
      // The room is already per-workspace; the header restates it so the DO can
      // refuse a frame that reached the wrong room rather than fan it out.
      headers: { "x-backlex-event-tenant": addr.tenantId ?? "" },
      body: JSON.stringify(payload),
    });
  } else if (redisRealtimeEnabled(env)) {
    // Stateless serverless (Vercel / Netlify) with Upstash configured: fan out
    // through a Redis Stream so subscribers on other invocations see the event.
    // The in-process map (publishLocal) wouldn't reach them.
    await redisPublish(env, topic, payload);
  } else if (itemsTransportKind(env) === "ably-signal") {
    // Stateless serverless with Ably and nothing else: the only thing that goes
    // out is an ID-ONLY signal — subscribers read the row back through the
    // permission-filtered REST path (see services/realtime-signal.ts). Rows
    // themselves NEVER cross this plane, so no per-subscriber filtering is lost.
    const signal = itemSignalFor(addr.channel, payload);
    // Non-row channels (`collections`, agent threads, …) have no signal shape;
    // they simply have no serverless transport here, same as before.
    if (signal) await ablyPublishSignal(env.ABLY_API_KEY!, addr.tenantId, signal);
  } else {
    publishLocal(addr, payload);
  }
  // Webhook + flow dispatch (fire-and-forget) for ItemEvent-shaped payloads.
  // Item events do not carry `tenant_id` (the serializer only emits declared
  // fields), so the scope comes from the address — a payload-derived one
  // silently falls open and delivers one workspace's rows to every other
  // workspace's webhooks/flows.
  if (
    serverCtx &&
    typeof payload === "object" &&
    payload !== null &&
    "event" in payload &&
    "data" in payload
  ) {
    dispatchEventHandlers(env, addr, payload as ItemEventPayload, serverCtx);
  }
};
