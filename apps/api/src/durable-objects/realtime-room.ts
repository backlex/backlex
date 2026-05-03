/**
 * Durable Object that fans out messages to subscribed WebSockets in a single
 * channel. Bound as `REALTIME` in wrangler.toml.
 */
export class RealtimeRoom {
  private sockets = new Set<WebSocket>();

  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/subscribe") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      this.sockets.add(server);
      server.addEventListener("close", () => this.sockets.delete(server));
      server.addEventListener("error", () => this.sockets.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/publish" && req.method === "POST") {
      const body = await req.text();
      for (const ws of this.sockets) {
        try {
          ws.send(body);
        } catch {
          this.sockets.delete(ws);
        }
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
