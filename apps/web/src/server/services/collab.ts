/**
 * Collaboration channels (`collab:item:<slug>:<id>`) — record-level presence
 * and field awareness for the admin editor.
 *
 * This service owns everything transport-independent: channel parsing, the
 * publish input schema, server-side identity stamping, and the transport
 * capability answer the SPA reads from `GET /api/realtime/collab-config`.
 * Fan-out itself rides the existing realtime transports (in-process / DO /
 * Redis Stream) — the protocol is stateless (see @backlex/core adapters/realtime),
 * so no per-transport membership state is needed.
 */
import { z } from "@hono/zod-openapi";
import type {
  CollabConfig,
  CollabMessage,
  CollabTransportKind,
} from "@backlex/core";
import type { Env } from "../env";
import { redisRealtimeEnabled } from "./realtime-redis";
import { isNetlify, isStatelessEdge, isVercel } from "../lib/runtime";

export const COLLAB_PREFIX = "collab:";
const COLLAB_ITEM_PREFIX = "collab:item:";
const COLLAB_LIST_PREFIX = "collab:list:";

export interface CollabChannelScope {
  slug: string;
  /** Set for the legacy per-record shape (`collab:item:<slug>:<id>`); absent
   *  for the collection-wide shape (`collab:list:<slug>`). */
  itemId?: string;
}

/** Parse a collab channel name → its collection scope, or null when the
 *  channel isn't well-formed. Two shapes are accepted:
 *   - `collab:list:<slug>` — ONE channel per collection; every message carries
 *     its record id in the body (`item`). This is what the SPA uses: the item
 *     editor and the list view share the subscription, so a 50-row table costs
 *     one channel instead of fifty.
 *   - `collab:item:<slug>:<id>` — the original per-record shape, kept so SPA
 *     bundles from before the switch keep working across a deploy.
 *  Unknown `collab:*` shapes are rejected (null), not treated as free-form
 *  channels. */
export const parseCollabChannel = (channel: string): CollabChannelScope | null => {
  if (channel.startsWith(COLLAB_LIST_PREFIX)) {
    const slug = channel.slice(COLLAB_LIST_PREFIX.length);
    if (!slug || slug.includes(":")) return null;
    return { slug };
  }
  if (!channel.startsWith(COLLAB_ITEM_PREFIX)) return null;
  const rest = channel.slice(COLLAB_ITEM_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { slug: rest.slice(0, sep), itemId: rest.slice(sep + 1) };
};

export const AGENT_THREAD_PREFIX = "agent:thread:";

/** Parse `agent:thread:<threadId>` → the thread id, or null when malformed. */
export const parseAgentThreadChannel = (channel: string): string | null => {
  if (!channel.startsWith(AGENT_THREAD_PREFIX)) return null;
  const id = channel.slice(AGENT_THREAD_PREFIX.length);
  return id && !id.includes(":") ? id : null;
};

/** Presence protocol for an agent thread — the only thing a client may publish
 *  on `agent:thread:*` (the turn events themselves are server-emitted). `typing`
 *  carries no text: it says someone is composing, never what they're writing. */
export const AgentPresenceSchema = z
  .object({ t: z.enum(["hello", "ping", "typing", "bye"]) })
  .strict()
  .openapi("AgentPresenceInput");

export interface AgentPresenceMessage {
  event: "agent.presence";
  data: {
    t: "hello" | "ping" | "typing" | "bye";
    user: { id: string; name: string | null };
    at: number;
  };
}

/** Wrap a validated presence input in the `{event, data}` envelope the agent
 *  channel already uses, with identity stamped from the session so a member
 *  can't appear as someone else. */
export const buildAgentPresenceMessage = (
  input: z.infer<typeof AgentPresenceSchema>,
  auth: { userId: string; email: string | null },
): AgentPresenceMessage => ({
  event: "agent.presence",
  data: {
    t: input.t,
    user: { id: auth.userId, name: auth.email },
    at: Date.now(),
  },
});

export const CollabPublishSchema = z
  .object({
    t: z.enum(["hello", "focus", "blur", "ping", "bye"]),
    item: z.string().min(1).max(128).optional(),
    field: z.string().min(1).max(128).optional(),
  })
  .strict()
  .openapi("CollabPublishInput");

/** Build the wire message from a validated client input: identity and
 *  timestamp are server-stamped so a member can't impersonate another. */
export const buildCollabMessage = (
  input: z.infer<typeof CollabPublishSchema>,
  auth: { userId: string; email: string | null },
): CollabMessage => ({
  t: input.t,
  user: { id: auth.userId, name: auth.email },
  // Which record the sender is on — every editor message carries it on the
  // collection-wide channel. Absent on an observer hello (list view).
  ...(input.item ? { item: input.item } : {}),
  // `field` only makes sense on focus (claim) and ping (held-field heartbeat).
  ...(input.field && (input.t === "focus" || input.t === "ping")
    ? { field: input.field }
    : {}),
  at: Date.now(),
});

/**
 * Which collab transport this deployment supports. Priority (per the collab
 * design doc): Durable Object → long-lived process (Bun, in-process bus) →
 * Ably (`ABLY_API_KEY`) → Redis long-poll fallback → off.
 *
 * On stateless serverless, Ably beats the Redis fallback deliberately: the
 * browser connects to Ably directly, so awareness traffic costs zero function
 * invocations and zero Redis commands — the Redis long-poll burns ~0.9
 * commands/sec per open editor and holds a function invocation open, which
 * free tiers can't absorb. Redis stays as the fallback for deployments that
 * already run Upstash and haven't configured Ably.
 */
export const collabTransportKind = (env: Env): CollabTransportKind => {
  if (env.REALTIME) return "native";
  if (!(isStatelessEdge() || isVercel() || isNetlify())) return "native";
  if (env.ABLY_API_KEY) return "ably";
  if (redisRealtimeEnabled(env)) return "native";
  return "off";
};

export const collabConfig = (env: Env): CollabConfig => ({
  transport: collabTransportKind(env),
});

// --- Ably token minting ------------------------------------------------------
//
// The server never proxies Ably traffic — it only signs TokenRequests (the
// standard Ably token-auth flow) with the API key's secret, scoped to the
// collab channels the caller passed the permission gate for. The browser
// exchanges the TokenRequest with Ably directly. Implemented against the Ably
// REST token spec with WebCrypto so no SDK ships in the server bundle and it
// runs on every runtime (Workers / Edge included).

/** Signed Ably TokenRequest — the exact shape ably-js `authCallback` expects. */
export interface AblyTokenRequest {
  keyName: string;
  ttl: number;
  capability: string;
  clientId: string;
  timestamp: number;
  nonce: string;
  mac: string;
}

const ABLY_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Sign an Ably TokenRequest for exactly `capabilities` — a map of channel name
 * → allowed operations, built by the caller AFTER each channel passed the same
 * permission gate a native subscribe would apply.
 *
 * The ops differ per plane: collab channels need `publish` + `subscribe` (every
 * member both announces and listens), while the signal data plane is
 * `subscribe`-only — signals are server-emitted, and a client that could
 * publish them could fabricate change notifications for other readers.
 */
export const mintAblyTokenRequest = async (
  apiKey: string,
  clientId: string,
  capabilities: Record<string, string[]>,
): Promise<AblyTokenRequest> => {
  const sep = apiKey.indexOf(":");
  if (sep <= 0) throw new Error("ABLY_API_KEY must be in keyName:keySecret form");
  const keyName = apiKey.slice(0, sep);
  const keySecret = apiKey.slice(sep + 1);

  const capability = JSON.stringify(capabilities);
  const ttl = ABLY_TOKEN_TTL_MS;
  const timestamp = Date.now();
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // Ably REST token spec: newline-joined sign text, HMAC-SHA256, base64.
  const signText = `${keyName}\n${ttl}\n${capability}\n${clientId}\n${timestamp}\n${nonce}\n`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keySecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signText));
  const mac = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return { keyName, ttl, capability, clientId, timestamp, nonce, mac };
};
