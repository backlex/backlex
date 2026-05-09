# Realtime

Permission-aware change feed over Server-Sent Events (Bun, Vercel,
Netlify) or WebSockets via Durable Objects (Cloudflare Workers).

## Channels

| Channel name        | Auth          | Filtered     | What lands on it                                       |
|---------------------|---------------|--------------|--------------------------------------------------------|
| `items:<slug>`      | session/key   | yes          | `created`/`updated`/`deleted` for the collection       |
| `collections`       | admin only    | yes          | Schema events                                          |
| anything else       | none          | no           | Free-form pub/sub (back-compat)                        |

System channels (`items:*`, `collections`) reject external publish —
events come from the API itself when CRUD routes fire. Free-form
channels accept any payload via `POST /api/realtime/<channel>/publish`.

## Subscribing

```ts
const es = new EventSource("/api/realtime/items:posts/subscribe", {
  withCredentials: true,
});
es.addEventListener("message", (ev) => {
  const e = JSON.parse(ev.data); // { event: "created"|..., data: { ... } }
  switch (e.event) {
    case "created": appendToList(e.data); break;
    case "updated": updateInPlace(e.data); break;
    case "deleted": removeById(e.data.id); break;
  }
});
es.addEventListener("error", () => { /* reconnect logic */ });
```

Or via the SDK:

```ts
import { createClient } from "@workeros/client";
const wks = createClient({ url: "https://api.your.app" });
const off = wks.subscribe<Posts>("items:posts", (e) => { /* … */ });
// later: off();
```

## How filtering works

When a subscriber connects, the API resolves their `read` permission for
the target collection. Three pieces are stored with the connection:

1. `authSubject` — `{ userId, email, roles }`
2. `conditions` — array of raw `Condition` objects, or `null` when
   permission is unconditional.
3. `fields` — allow-list of field names, or `null` when all fields are
   readable.

For each event the API publishes:

- The condition list is OR-combined and `matchesCondition` runs against
  the event's `data`. The matcher uses the same DSL as the SQL filter
  compiler — owners only see their own items, etc.
- If the event passes, the `data` is filtered down to the field
  allow-list (system fields `id, createdAt, updatedAt, ownerId` are
  always kept).
- The result is sent to the subscriber.

So a feed for `items:posts` gives admin every event, owner-scoped users
their own item events, and anonymous users nothing (no `public` read
permission means subscribe rejects with 401).

## Hosting matrix

| Host               | Transport          | Notes                                                       |
|--------------------|--------------------|-------------------------------------------------------------|
| Bun (self-host)    | SSE                | In-process `Map<channel, Set<Subscriber>>`. Pub/sub stays in one process — fine for single-instance deploys. |
| Cloudflare Workers | WebSocket via DO   | `RealtimeRoom` Durable Object holds connections; the API forwards publishes via stub. |
| Vercel Edge        | SSE                | Single-instance: each edge function invocation gets its own Map; multi-region replicas don't share. **Single-region deploys only** if you need fan-out. |
| Netlify Edge       | SSE                | Same caveat as Vercel.                                      |

For multi-region/multi-process realtime on Vercel/Netlify, plug a Pub/Sub
backend (Redis, NATS, Cloudflare DO + service-to-service) — not yet
shipped.

## Bun SSE: queue + flush gotcha

Hono's `streamSSE` exposes `writeSSE` as an async function. Don't call
it from a synchronous subscriber callback with `void` — the writes get
batched and the client doesn't see them until the request closes. The
fix in `routes/realtime.ts` is a queue + wakeable promise: the
subscriber callback pushes to a queue, the SSE async loop awaits each
`writeSSE` explicitly. Don't change this without testing — silent
non-delivery is the failure mode.

## Channels you can publish to manually

```bash
curl -X POST /api/realtime/team-chat/publish \
  -H "content-type: application/json" \
  -d '{"text":"hello"}'
```

Free-form channel names (anything that doesn't start with `items:` or
isn't `collections`) are open — no auth, no filter. Useful for chat-like
or notification fan-out where you don't need a permission-bound feed.
