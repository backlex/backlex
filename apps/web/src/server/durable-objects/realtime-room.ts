import { matchesCondition } from "@workeros/db";
import type { AuthSubject, Condition } from "@workeros/core";

interface Meta {
  authSubject: AuthSubject;
  conditions: Condition[] | null;
  fields: string[] | null;
}

const SYSTEM_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "ownerId",
]);

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

/**
 * Durable Object that fans out messages to subscribed WebSockets in a single
 * channel, optionally applying a per-subscriber permission filter.
 *
 * Subscribers attach a base64(JSON) `meta=` query param; if present, each
 * published item event is evaluated against the subscriber's conditions
 * before being forwarded.
 */
export class RealtimeRoom {
  private sockets = new Map<WebSocket, Meta | null>();

  constructor(_state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/subscribe") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();

      let meta: Meta | null = null;
      const metaRaw = url.searchParams.get("meta");
      if (metaRaw) {
        try {
          meta = JSON.parse(atob(metaRaw)) as Meta;
        } catch {
          // ignore malformed meta; treat as unfiltered
        }
      }
      this.sockets.set(server, meta);
      server.addEventListener("close", () => this.sockets.delete(server));
      server.addEventListener("error", () => this.sockets.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/publish" && req.method === "POST") {
      const text = await req.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
      const isItem =
        typeof payload === "object" &&
        payload !== null &&
        "event" in (payload as object) &&
        "data" in (payload as object);

      for (const [ws, meta] of this.sockets) {
        try {
          if (meta && isItem) {
            const p = payload as { event: string; data: Record<string, unknown> };
            const passes =
              meta.conditions === null
                ? true
                : meta.conditions.length === 0
                  ? false
                  : meta.conditions.some((c) =>
                      matchesCondition(p.data, c, meta.authSubject),
                    );
            if (!passes) continue;
            const out = meta.fields
              ? { ...p, data: project(p.data, meta.fields) }
              : p;
            ws.send(JSON.stringify(out));
          } else {
            ws.send(text);
          }
        } catch {
          this.sockets.delete(ws);
        }
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
