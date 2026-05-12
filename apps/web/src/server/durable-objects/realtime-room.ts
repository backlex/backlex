import { matchesCondition } from "@workeros/db";
import type { AuthSubject, Condition } from "@workeros/core";

interface Meta {
  authSubject: AuthSubject;
  conditions: Condition[] | null;
  fields: string[] | null;
}

interface PresenceIdentity {
  userId: string;
  email: string | null;
}

/** What we hang off each hibernatable socket via serializeAttachment. */
interface Attachment {
  meta: Meta | null;
  presence: PresenceIdentity | null;
}

interface StoredEvent {
  seq: number;
  /** Raw text of the published payload (JSON or plain string). */
  text: string;
}

const SYSTEM_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "ownerId",
]);

/** How many recent events to retain for `?since=` replay on reconnect. */
const REPLAY_LIMIT = 50;
/** Presence roster frames carry seq 0 — never replayed, never an SSE id. */
const PRESENCE_SEQ = 0;

const project = (
  data: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> => {
  const allow = new Set(fields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SYSTEM_FIELDS.has(k) || allow.has(k)) out[k] = v;
  }
  return out;
};

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

      this.state.acceptWebSocket(server);
      try {
        server.serializeAttachment({ meta, presence } satisfies Attachment);
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
          this.deliver(server, meta, ev);
        }
      }
      if (presence) this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/publish" && req.method === "POST") {
      const text = await req.text();
      this.seq += 1;
      const ev: StoredEvent = { seq: this.seq, text };
      this.log.push(ev);
      if (this.log.length > REPLAY_LIMIT) {
        this.log.splice(0, this.log.length - REPLAY_LIMIT);
      }
      await this.state.storage.put({ seq: this.seq, log: this.log });

      for (const ws of this.state.getWebSockets()) {
        this.deliver(ws, this.attachment(ws).meta, ev);
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

  private broadcastPresence(exclude?: WebSocket): void {
    const sockets = this.state.getWebSockets();
    const byId = new Map<string, PresenceIdentity>();
    for (const ws of sockets) {
      if (ws === exclude) continue;
      const p = this.attachment(ws).presence;
      if (p) byId.set(p.userId, p);
    }
    const members = [...byId.values()].sort((a, b) =>
      (a.email ?? a.userId).localeCompare(b.email ?? b.userId),
    );
    const text = JSON.stringify({ event: "presence", data: { members } });
    for (const ws of sockets) {
      if (ws === exclude) continue;
      if (!this.attachment(ws).presence) continue;
      try {
        ws.send(frame(PRESENCE_SEQ, text));
      } catch {
        // socket is gone; the hibernation runtime will fire webSocketClose
      }
    }
  }

  private deliver(ws: WebSocket, meta: Meta | null, ev: StoredEvent) {
    let payload: unknown;
    try {
      payload = JSON.parse(ev.text);
    } catch {
      payload = ev.text;
    }
    let outText: string;
    if (meta && isItemPayload(payload)) {
      const passes =
        meta.conditions === null
          ? true
          : meta.conditions.length === 0
            ? false
            : meta.conditions.some((c) =>
                matchesCondition(payload.data, c, meta.authSubject),
              );
      if (!passes) return;
      const out = meta.fields
        ? { event: payload.event, data: project(payload.data, meta.fields) }
        : payload;
      outText = JSON.stringify(out);
    } else {
      outText = ev.text;
    }
    try {
      ws.send(frame(ev.seq, outText));
    } catch {
      // socket is gone; the hibernation runtime will fire webSocketClose
    }
  }
}
