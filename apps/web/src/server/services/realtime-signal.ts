/**
 * Signal-only data plane (`signal:items:<slug>`) — realtime row events for
 * stateless serverless runtimes, over Ably.
 *
 * ## Why a second data plane exists
 *
 * The `items:*` SSE plane renders every event PER SUBSCRIBER: permission
 * conditions, the live-query filter and the field allow-list are all applied
 * server-side (`renderItemEvent`). That's exactly why the data plane could
 * never move to a hosted pub/sub — Ably fans out one payload to everyone, and
 * we have no place to run per-connection filtering inside it.
 *
 * So this plane doesn't ship rows. It ships the FACT that a row changed —
 * `{event, collection, id, at}`, nothing else — and the client reads the row
 * back through the ordinary REST list endpoint, where the permission gate, the
 * row conditions and the field projection all still run. A row the subscriber
 * isn't allowed to see simply doesn't come back, and the client treats that
 * absence as "drop it". Filtering fidelity is preserved; only the delivery
 * mechanism changed.
 *
 * ## Why it's worth it
 *
 * On Vercel / Netlify Functions there is no Durable Object and no long-lived
 * process, so today the only cross-instance transport is the Upstash Redis
 * long-poll — which holds a function invocation open per subscriber (~130K
 * invocations/month for ONE always-open tab, against a 125K free tier) and
 * burns ~3,600 Redis commands per editor-hour. With Ably the browser connects
 * to Ably directly: delivery costs zero function invocations, and the server
 * only pays one REST publish per write. That's what makes realtime work on a
 * fully free deployment.
 *
 * ## The metadata trade-off (and how it's bounded)
 *
 * Row DATA never leaks — the refetch enforces that. What a subscriber can still
 * observe is the ID and the TIMING of every change in a collection it can read,
 * including rows a row-level permission condition would have hidden from it on
 * the SSE plane (where `renderItemEvent` suppresses the event outright).
 *
 * So the signal plane is offered only to subscribers whose `read` permission on
 * the collection is UNCONDITIONAL — admins, and roles whose permission row
 * carries no `condition`. Those subscribers can enumerate every id in the
 * collection through the REST API anyway, so the signal tells them nothing new.
 * A subscriber with a row condition is refused a token and degrades to "no
 * realtime" rather than silently gaining visibility it doesn't have over HTTP.
 * `REALTIME_SIGNAL_SCOPE=all` waives that check for deployments where change
 * timing isn't sensitive.
 */
import type { ItemSignal, ItemsConfig, ItemsTransportKind } from "@backlex/core";
import type { Env } from "../env";
import { redisRealtimeEnabled } from "./realtime-redis";
import { isNetlify, isStatelessEdge, isVercel } from "../lib/runtime";

/** Namespace root. Every `signal:*` channel must resolve to a known shape —
 *  an unrecognised one is rejected, never treated as a free-form channel. */
export const SIGNAL_ROOT = "signal:";
export const SIGNAL_PREFIX = "signal:items:";
const ITEMS_PREFIX = "items:";

/** `signal:items:<slug>` for a collection. */
export const signalChannel = (slug: string): string => `${SIGNAL_PREFIX}${slug}`;

/**
 * The Ably room a workspace's `channel` lives in — signal AND collab, which is
 * why it is not named for either.
 *
 * Ably is the one transport where the room name is chosen by the CLIENT: the
 * browser connects to Ably directly and attaches to whatever name it holds, so
 * the name has to be STATED on the wire rather than derived independently on
 * each side. The server mints the token capability for this exact name and
 * hands the prefix back on `GET /api/realtime/items-config` and
 * `/collab-config`, so a client that never learns its workspace cannot
 * construct another's, and one that names another's anyway is minted a
 * capability for that name nested inside its own — a room nobody publishes to.
 *
 * Deliberately not `topicFor`: that is an internal routing key and uses a
 * separator no channel name may contain. This string is a public identifier
 * held by a third-party SDK and by Ably itself, so it stays inside the
 * `[A-Za-z0-9_.@-]` / `:` charset both Ably and `splitChannel` accept. It is
 * not relied on for unforgeability — the token capability is.
 */
export const ablyRoomPrefix = (tenantId: string | null): string =>
  `t.${tenantId ?? "_"}:`;

/**
 * The prefix to hand a caller on the config endpoints, or `""` when there is
 * nobody to hand it to.
 *
 * Both config endpoints are open (they answer a capability question a client
 * asks before it has done anything), and `auth.tenantId` resolves to a
 * workspace for an anonymous caller too — so returning the prefix
 * unconditionally would turn a workspace SLUG into its UUID for anyone who
 * asks. No privilege attaches to that id, but nothing anonymous can use the
 * prefix either: `gateForChannel` refuses a `signal:` or `collab:` subscribe
 * without a session, so no token is ever minted. Answering `""` costs a
 * signed-out caller nothing and stops publishing an identifier gratuitously.
 */
export const ablyRoomPrefixFor = (auth: {
  userId: string | null;
  tenantId?: string | null;
}): string => (auth.userId ? ablyRoomPrefix(auth.tenantId ?? null) : "");

/** Namespace an Ably channel for the workspace that owns it. */
export const ablyRoom = (tenantId: string | null, channel: string): string =>
  `${ablyRoomPrefix(tenantId)}${channel}`;

/** Parse `signal:items:<slug>` → the slug, or null when malformed. Rejecting
 *  malformed shapes matters: an unrecognised `signal:*` channel must NOT fall
 *  through to the free-form (unauthenticated) channel branch of the gate. */
export const parseSignalChannel = (channel: string): string | null => {
  if (!channel.startsWith(SIGNAL_PREFIX)) return null;
  const slug = channel.slice(SIGNAL_PREFIX.length);
  return slug && !slug.includes(":") ? slug : null;
};

/**
 * Which data-plane transport this deployment offers.
 *
 * Priority is deliberately NON-destructive: every runtime that can already
 * serve the full-fidelity `items:*` SSE stream keeps it, and `ably-signal` only
 * fills the case that was previously `off`. A deployment that configured
 * Upstash has opted into the long-poll's cost and gets to keep server-side
 * filtering + `Last-Event-ID` replay; downgrading it to id-only signals would
 * be a regression, not an upgrade.
 */
export const itemsTransportKind = (env: Env): ItemsTransportKind => {
  if (env.REALTIME) return "sse";
  if (!(isStatelessEdge() || isVercel() || isNetlify())) return "sse";
  if (redisRealtimeEnabled(env)) return "sse";
  if (env.ABLY_API_KEY) return "ably-signal";
  return "off";
};

export const itemsConfig = (env: Env): ItemsConfig => ({
  transport: itemsTransportKind(env),
});

/** Whether the signal plane is offered to subscribers whose read permission
 *  carries row conditions. Default: no (see the module header). */
export const signalScopeAllowsConditional = (env: Env): boolean =>
  env.REALTIME_SIGNAL_SCOPE === "all";

/**
 * Derive the wire signal for an `items:<slug>` publish, or `null` when the
 * payload isn't a row event we can signal (no usable id — the client would have
 * nothing to refetch).
 */
export const itemSignalFor = (
  channel: string,
  payload: unknown,
): ItemSignal | null => {
  if (!channel.startsWith(ITEMS_PREFIX)) return null;
  const slug = channel.slice(ITEMS_PREFIX.length);
  if (!slug) return null;
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { event?: unknown; data?: unknown };
  if (p.event !== "created" && p.event !== "updated" && p.event !== "deleted") {
    return null;
  }
  const data = p.data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  return { event: p.event, collection: slug, id: String(id), at: Date.now() };
};

// --- Ably REST publish -------------------------------------------------------
//
// Server → Ably is a plain authenticated REST call (no SDK in the server
// bundle, so it runs on every runtime including Workers/Edge). Subscribers pay
// nothing for it: they're connected to Ably directly, not to us.

const ABLY_REST_BASE = "https://rest.ably.io";
/** Message name every signal is published under — clients subscribe to it. */
export const SIGNAL_MESSAGE_NAME = "signal";

/** Basic-auth header for the Ably REST API from a `keyName:keySecret` key. */
const ablyAuthHeader = (apiKey: string): string => {
  if (apiKey.indexOf(":") <= 0) {
    throw new Error("ABLY_API_KEY must be in keyName:keySecret form");
  }
  return `Basic ${btoa(apiKey)}`;
};

/**
 * Publish one signal to its channel over the Ably REST API. Throws on a
 * non-2xx so a broken key surfaces in logs instead of silently dark'ing
 * realtime for the whole deployment.
 */
export const ablyPublishSignal = async (
  apiKey: string,
  tenantId: string | null,
  signal: ItemSignal,
): Promise<void> => {
  const channel = ablyRoom(tenantId, signalChannel(signal.collection));
  const res = await fetch(
    `${ABLY_REST_BASE}/channels/${encodeURIComponent(channel)}/messages`,
    {
      method: "POST",
      headers: {
        authorization: ablyAuthHeader(apiKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: SIGNAL_MESSAGE_NAME, data: signal }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Ably publish to ${channel} failed: ${res.status} ${await res.text()}`,
    );
  }
};
