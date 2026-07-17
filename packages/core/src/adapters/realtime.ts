/**
 * Collaboration realtime contract — the wire protocol for `collab:*` channels
 * (record-level presence + field awareness in the admin editor).
 *
 * The protocol is deliberately STATELESS: no server-side roster exists. Every
 * client derives the member list from the message stream itself (hello/ping
 * with a TTL sweep), so the messages flow over any fan-out transport —
 * in-process (Bun), Durable Object (Workers), Redis Stream (serverless), or a
 * hosted pub/sub (Ably, phase 2) — without per-transport membership state.
 *
 * Identity is stamped SERVER-SIDE at publish time (`user` comes from the
 * session, never from the client body), so a member can't impersonate another.
 */

export type CollabMessageType =
  /** Sent once when a member opens the record. Other members reply with a
   *  jittered `ping` so the newcomer builds the roster without any replay. */
  | "hello"
  /** The member focused an editor field (`field` is set). */
  | "focus"
  /** The member left the field it was editing. */
  | "blur"
  /** Liveness heartbeat (every ~15s); carries the currently focused `field`
   *  when there is one, so a late joiner also learns focus state. */
  | "ping"
  /** Sent (best-effort) when the member closes the record. */
  | "bye";

export interface CollabUser {
  /** Session user id — server-stamped. */
  id: string;
  /** Display handle (email today) — server-stamped. */
  name: string | null;
}

export interface CollabMessage {
  t: CollabMessageType;
  user: CollabUser;
  /** Record id the sender is on. Collab rides ONE channel per collection
   *  (`collab:list:<slug>`), so every editor message carries its record —
   *  the editor roster filters on it and the list view groups rows by it.
   *  Absent on an observer `hello` (a list view announcing itself so editors
   *  reply with state); observers are never added to rosters. */
  item?: string;
  /** Focused field name — present on `focus`, and on `ping` while a field is
   *  held. Absent means "no field focused". */
  field?: string;
  /** Server epoch ms at publish time — drives the client TTL sweep. */
  at: number;
}

/** What the client sends to `POST /api/realtime/collab:…/publish` — identity
 *  and timestamp are added by the server. */
export interface CollabPublishInput {
  t: CollabMessageType;
  item?: string;
  field?: string;
}

/** How the admin SPA should reach collab channels on this deployment.
 *  `native` = the existing SSE subscribe + REST publish endpoints work.
 *  `ably` (phase 2) = client connects to Ably with a server-minted token.
 *  `off` = no viable transport; the UI hides collab affordances. */
export type CollabTransportKind = "native" | "ably" | "off";

export interface CollabConfig {
  transport: CollabTransportKind;
}
