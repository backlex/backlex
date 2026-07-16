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
 * Which collab transport this deployment supports (phase 1: native or off;
 * `ably` arrives in phase 2). Mirrors the subscribe/publish branch order in
 * routes/realtime.ts: a Durable Object or a Redis Stream reaches subscribers
 * on any runtime; the in-process bus only works on a long-lived process, so
 * serverless without Redis reports `off` instead of silently broadcasting
 * into a per-invocation void.
 */
export const collabTransportKind = (env: Env): CollabTransportKind => {
  if (env.REALTIME) return "native";
  if (redisRealtimeEnabled(env)) return "native";
  if (isStatelessEdge() || isVercel() || isNetlify()) return "off";
  return "native";
};

export const collabConfig = (env: Env): CollabConfig => ({
  transport: collabTransportKind(env),
});
