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

export interface CollabItemChannel {
  slug: string;
  itemId: string;
}

/** Parse `collab:item:<slug>:<id>` → `{slug, itemId}`, or null when the
 *  channel isn't a well-formed collab channel. Only the `item` scope exists
 *  today; unknown `collab:*` shapes are rejected (null), not treated as
 *  free-form channels. */
export const parseCollabChannel = (channel: string): CollabItemChannel | null => {
  if (!channel.startsWith(COLLAB_ITEM_PREFIX)) return null;
  const rest = channel.slice(COLLAB_ITEM_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { slug: rest.slice(0, sep), itemId: rest.slice(sep + 1) };
};

export const CollabPublishSchema = z
  .object({
    t: z.enum(["hello", "focus", "blur", "ping", "bye"]),
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

export const mintAblyTokenRequest = async (
  apiKey: string,
  clientId: string,
  channels: string[],
): Promise<AblyTokenRequest> => {
  const sep = apiKey.indexOf(":");
  if (sep <= 0) throw new Error("ABLY_API_KEY must be in keyName:keySecret form");
  const keyName = apiKey.slice(0, sep);
  const keySecret = apiKey.slice(sep + 1);

  // Capability map: exactly the gated channels, publish+subscribe only (no
  // history/presence ops needed — the collab protocol is message-based).
  const capability = JSON.stringify(
    Object.fromEntries(channels.map((ch) => [ch, ["publish", "subscribe"]])),
  );
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
