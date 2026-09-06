/**
 * The realtime bus routes by TOPIC, and a topic is a (workspace, channel) pair.
 *
 * Every transport keys its room on a single string: the Durable Object on
 * `idFromName`, Upstash on the stream key, the in-process bus on a `Map` key,
 * Ably on the channel name. That string used to be the channel alone — so two
 * workspaces that each owned a collection called `orders` published into ONE
 * room, and a subscriber gated against its OWN workspace received the other's
 * rows verbatim. `renderItemEvent` could not stop it: it applies the
 * subscriber's row conditions, and a workspace admin has none.
 *
 * ── why the tenant goes in the ROUTING KEY and not in the channel name ───────
 *
 * The obvious fix is to rename the channel to `t:<tenant>:items:<slug>`. That
 * would be wrong, because the channel name is a PUBLIC identifier with four
 * other jobs: it is the trigger key webhooks, flows, integrations and extension
 * hooks match on (`dispatchEventHandlers`), the argument the SDK's
 * `subscribe()` takes, the path segment of `/api/realtime/{channel}/subscribe`,
 * and the label the admin channel list and flow builder show. Renaming it would
 * silently stop every user-configured `items:orders` trigger from matching, and
 * break the published SDK, in exchange for isolation the routing key already
 * provides.
 *
 * So the channel keeps its name and the transport gets an address. The tenant
 * is derived server-side — on the publish side from the workspace that owns the
 * collection, on the subscribe side from `auth.tenantId` — and NEVER read from
 * the request path, or a caller would simply name someone else's prefix.
 *
 * ── why `|` ─────────────────────────────────────────────────────────────────
 *
 * A channel segment is `[A-Za-z0-9_.@-]+` joined by `:` (`splitChannel` in
 * `@backlex/core`), so `|` cannot occur in one. That makes the boundary
 * unforgeable rather than merely unlikely: even the loosely-parsed prefixes
 * (`presence:` takes any suffix at all) cannot craft a channel that reads as
 * another workspace's topic, because they cannot produce the separator. A `:`
 * separator would only have been safe by argument; this one is safe by
 * construction.
 */

/** Where an event is published, and where a subscriber listens. */
export interface ChannelAddress {
  /** The workspace the event belongs to. `null` is instance-global and is a
   *  room of its own — never a wildcard that matches every workspace. */
  tenantId: string | null;
  /** The logical, user-facing channel name (`items:orders`, `system`, …). */
  channel: string;
}

/** Marks a topic with no workspace. `_` cannot be a tenant id (they are
 *  UUIDs), so this cannot collide with a real one. */
const GLOBAL = "_";

/** The transport-level routing key for an address. */
export const topicFor = (addr: ChannelAddress): string =>
  `t|${addr.tenantId ?? GLOBAL}|${addr.channel}`;

/**
 * Split a topic back into its address, or `null` if the string was not
 * produced by {@link topicFor}. Used by the admin channel listing, which
 * enumerates in-process rooms and must show the caller only their own.
 */
export const parseTopic = (topic: string): ChannelAddress | null => {
  if (!topic.startsWith("t|")) return null;
  const end = topic.indexOf("|", 2);
  if (end < 0) return null;
  const tenant = topic.slice(2, end);
  const channel = topic.slice(end + 1);
  if (!channel) return null;
  return { tenantId: tenant === GLOBAL ? null : tenant, channel };
};
