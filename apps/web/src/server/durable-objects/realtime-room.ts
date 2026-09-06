import type { AuthSubject, Condition } from "@backlex/core";
import {
  eventIsForSubscriber,
  renderItemEvent,
  stripBefore,
} from "../services/realtime-filter";

interface Meta {
  authSubject: AuthSubject;
  conditions: Condition[] | null;
  fields: string[] | null;
  /** Live-query filter, AND'd on top of `conditions` (reactive Stage 1). Rides
   *  along in the base64 `meta=` attachment from the Worker subscribe handler. */
  queryFilter?: Condition | null;
}

interface PresenceIdentity {
  userId: string;
  email: string | null;
}

/** What we hang off each hibernatable socket via serializeAttachment. */
interface Attachment {
  meta: Meta | null;
  presence: PresenceIdentity | null;
  /**
   * The workspace this socket was gated in. A room is already addressed per
   * workspace (`services/realtime-topic.ts` keys `idFromName`), so this is the
   * same answer asked a second time at delivery — it is what stops a frame that
   * somehow reached the wrong room from being fanned out of it.
   *
   * `undefined` on an attachment written by an older build. Treated as a
   * mismatch, not a wildcard — see `eventIsForSubscriber`.
   */
  tenant?: string | null;
}

interface StoredEvent {
  seq: number;
  /** Raw text of the published payload (JSON or plain string). */
  text: string;
  /** Workspace that published it. `undefined` for entries this room's replay
   *  log already held before the field existed. */
  tenant?: string | null;
}

/** How many recent events to retain for `?since=` replay on reconnect. */
const REPLAY_LIMIT = 50;
/** Presence roster frames carry seq 0 — never replayed, never an SSE id. */
const PRESENCE_SEQ = 0;

const isItemPayload = (
  payload: unknown,
): payload is { event: string; data: Record<string, unknown> } =>
  typeof payload === "object" &&
  payload !== null &&
  "event" in (payload as object) &&
  "data" in (payload as object);

const frame = (seq: number, text: string): string =>
  JSON.stringify({ __seq: seq, msg: text });

/**
 * Durable Object that fans out messages to subscribed WebSockets in a single
 * channel, optionally applying a per-subscriber permission filter.
 *
 * - Subscribers attach a base64(JSON) `meta=` query param; if present, each
 *   published item event is evaluated against the subscriber's conditions
 *   before being forwarded.
 * - `presence=1` marks the socket as a presence member; join/leave re-broadcast
 *   the deduplicated roster as `{ event: "presence", data: { members } }`.
 * - Sockets are accepted via the WebSocket Hibernation API so the DO can be
 *   evicted from memory between messages (no idle billing); the per-socket
 *   `Attachment` rides along serialized and `seq`/event-log survive in storage.
 * - A `?since=<seq>` query param replays buffered events the client missed.
 * - Outgoing frames are wrapped as `{ "__seq": <n>, "msg": <text> }` so the
 *   Worker-side SSE bridge can echo the sequence number as the SSE event id.
 */
export class RealtimeRoom {
  private state: DurableObjectState;
  private seq = 0;
  private log: StoredEvent[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      this.seq = (await state.storage.get<number>("seq")) ?? 0;
      this.log = (await state.storage.get<StoredEvent[]>("log")) ?? [];
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/subscribe") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      let meta: Meta | null = null;
      const metaRaw = url.searchParams.get("meta");
      if (metaRaw) {
        try {
          meta = JSON.parse(atob(metaRaw)) as Meta;
        } catch {
          // ignore malformed meta; treat as unfiltered
        }
      }
      const presence: PresenceIdentity | null =
        url.searchParams.get("presence") === "1" && meta?.authSubject.userId
          ? { userId: meta.authSubject.userId, email: meta.authSubject.email ?? null }
          : null;
      // Sent as a separate param rather than read out of `meta`, because the
      // channels forwarded RAW (`collab:`, application-owned) are gated without
      // a meta at all — a tenant that lived inside it would be absent for
      // exactly the subscriptions with no other filter.
      // Absent (rather than empty) means the caller never stated a workspace —
      // kept distinct from `null`, which states "no active workspace", so a
      // subscribe path that forgets the param goes SILENT instead of wide.
      const tenant: string | null | undefined = url.searchParams.has("tenant")
        ? url.searchParams.get("tenant") || null
        : undefined;

      this.state.acceptWebSocket(server);
      try {
        server.serializeAttachment({ meta, presence, tenant } satisfies Attachment);
      } catch {
        // Attachment too large (>2KB). Falling back to in-memory-only filtering
        // would be unsafe (the socket would see everything after hibernation),
        // so close it instead.
        server.close(1011, "subscription metadata too large");
        return new Response(null, { status: 101, webSocket: client });
      }

      const since = Number(url.searchParams.get("since") ?? "");
      if (Number.isSafeInteger(since) && since > 0) {
        for (const ev of this.log) {
          if (ev.seq <= since) continue;
          this.deliver(server, meta, tenant, ev);
        }
      }
      if (presence) this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/stats") {
      // Read-only diagnostic snapshot. No auth at the DO level — DOs aren't
      // reachable from outside the Worker, so the admin gate runs once at
      // the route layer (`routes/realtime-admin.ts`) and trusts what the DO
      // returns.
      const sockets = this.state.getWebSockets();
      let presenceMembers = 0;
      for (const ws of sockets) {
        if (this.attachment(ws).presence) presenceMembers += 1;
      }
      return Response.json({
        connectedSockets: sockets.length,
        presenceMembers,
        currentSeq: this.seq,
        logSize: this.log.length,
      });
    }

    if (url.pathname === "/publish" && req.method === "POST") {
      const text = await req.text();
      const stated = req.headers.get("x-backlex-event-tenant");
      const tenant: string | null | undefined =
        stated === null ? undefined : stated || null;
      this.seq += 1;
      const ev: StoredEvent = { seq: this.seq, text, tenant };
      this.log.push(ev);
      if (this.log.length > REPLAY_LIMIT) {
        this.log.splice(0, this.log.length - REPLAY_LIMIT);
      }
      await this.state.storage.put({ seq: this.seq, log: this.log });

      for (const ws of this.state.getWebSockets()) {
        const a = this.attachment(ws);
        this.deliver(ws, a.meta, a.tenant, ev);
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  // --- WebSocket Hibernation API handlers -------------------------------------

  // Subscribers are read-only; ignore anything they send.
  async webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string) {}

  async webSocketClose(ws: WebSocket) {
    const wasPresence = this.attachment(ws).presence !== null;
    try {
      // Peer close codes like 1006 can't be echoed; 1000 is the safe substitute.
      ws.close(1000);
    } catch {
      // already closed
    }
    if (wasPresence) this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket) {
    const wasPresence = this.attachment(ws).presence !== null;
    try {
      ws.close(1011, "socket error");
    } catch {
      // already closed
    }
    if (wasPresence) this.broadcastPresence(ws);
  }

  // ---------------------------------------------------------------------------

  private attachment(ws: WebSocket): Attachment {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a ?? { meta: null, presence: null };
  }

  /**
   * Re-announce the presence roster.
   *
   * Rostered PER WORKSPACE rather than per room. A room is already addressed
   * per workspace, so in practice every socket here shares one — but a roster
   * names people, and "who else is on this record" is the one payload on this
   * channel that carries identity with no permission filter in front of it. It
   * is built from the sockets themselves, so it is the one place the room's own
   * bookkeeping could leak across a boundary the routing key was supposed to
   * hold. Grouping costs one pass and removes the question.
   */
  private broadcastPresence(exclude?: WebSocket): void {
    const sockets = this.state.getWebSockets();
    const key = (t: string | null | undefined) =>
      // "unstated" is not a tenant id, so it cannot collide with `t:<id>`.
      t === undefined ? "unstated" : `t:${t}`;
    const groups = new Map<string, Map<string, PresenceIdentity>>();
    for (const ws of sockets) {
      if (ws === exclude) continue;
      const a = this.attachment(ws);
      if (!a.presence) continue;
      const k = key(a.tenant);
      let byId = groups.get(k);
      if (!byId) {
        byId = new Map();
        groups.set(k, byId);
      }
      byId.set(a.presence.userId, a.presence);
    }
    const texts = new Map<string, string>();
    for (const [k, byId] of groups) {
      const members = [...byId.values()].sort((a, b) =>
        (a.email ?? a.userId).localeCompare(b.email ?? b.userId),
      );
      texts.set(k, JSON.stringify({ event: "presence", data: { members } }));
    }
    for (const ws of sockets) {
      if (ws === exclude) continue;
      const a = this.attachment(ws);
      if (!a.presence) continue;
      const text = texts.get(key(a.tenant));
      if (!text) continue;
      try {
        ws.send(frame(PRESENCE_SEQ, text));
      } catch {
        // socket is gone; the hibernation runtime will fire webSocketClose
      }
    }
  }

  private deliver(
    ws: WebSocket,
    meta: Meta | null,
    subscriberTenant: string | null | undefined,
    ev: StoredEvent,
  ) {
    // Ahead of any rendering, because the raw-forward branch below has no
    // permission filter of its own — `collab:` and application-owned channels
    // reach it verbatim.
    if (!eventIsForSubscriber(ev.tenant, subscriberTenant)) return;
    let payload: unknown;
    try {
      payload = JSON.parse(ev.text);
    } catch {
      payload = ev.text;
    }
    let outText: string;
    if (meta && isItemPayload(payload)) {
      const rendered = renderItemEvent(
        payload as Parameters<typeof renderItemEvent>[0],
        meta,
      );
      if (rendered === null) return;
      outText = JSON.stringify(rendered);
    } else {
      // No meta — strip the server-only `before` before forwarding raw.
      outText = isItemPayload(payload) ? JSON.stringify(stripBefore(payload)) : ev.text;
    }
    try {
      ws.send(frame(ev.seq, outText));
    } catch {
      // socket is gone; the hibernation runtime will fire webSocketClose
    }
  }
}
