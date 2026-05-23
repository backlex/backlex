---
title: Realtime
description: Permission-aware change feed over SSE, with a Durable Object bridge on Workers.
---

# Realtime

Permission-aware change feed over Server-Sent Events. **The client
transport is always SSE (`EventSource`)** — on Cloudflare Workers the
route bridges an internal Durable Object WebSocket into an SSE
response, so admin / SDK code never speaks raw WebSocket.

## Channels

| Channel name        | Auth          | Filtered     | What lands on it                                       |
|---------------------|---------------|--------------|--------------------------------------------------------|
| `items:<slug>`      | session/key   | yes          | `created`/`updated`/`deleted` for the collection       |
| `collections`       | admin only    | yes          | Schema events                                          |
| `presence:<name>`   | signed-in     | no           | Roster of currently connected members on the channel   |
| anything else       | none          | no           | Free-form pub/sub (back-compat)                        |

System channels (`items:*`, `collections`, `presence:*`) reject external
publish — events come from the API itself when CRUD routes fire (or, for
presence, on join/leave). Free-form channels accept any payload via
`POST /api/realtime/<channel>/publish`; that endpoint is rate-limited
per `(channel, ip)`. Admins can also call
`POST /api/realtime/items:<slug>/test-publish` to inject a synthetic
`{event,data}` for verifying per-subscriber filtering — no webhook /
flow / function side-effects fire.

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

| Host               | Client transport   | Server fan-out                                                                                                  |
|--------------------|--------------------|------------------------------------------------------------------------------------------------------------------|
| Bun (self-host)    | SSE                | In-process `Map<channel, Set<Subscriber>>` + a bounded per-channel ring buffer for replay. Single-instance only. |
| Cloudflare Workers | SSE                | SSE response bridged into the `RealtimeRoom` Durable Object (WebSocket Hibernation API; `seq` + recent-event log persisted in `state.storage`). |
| Vercel Edge        | SSE                | Single-instance: each edge function invocation gets its own Map; multi-region replicas don't share.              |
| Netlify Edge       | SSE                | Same caveat as Vercel.                                                                                            |

The server still chooses different fan-out paths under the hood (in-proc
Map on Bun, Durable Object on Workers), but every subscriber sees the
same SSE wire format: `data:` frames carrying JSON, `id:` carrying a
monotonic per-channel `seq`, `: ping` keep-alives every 25 s.
Reconnecting clients with `Last-Event-ID` replay the gap (bounded ring
buffer on Bun, `storage`-backed log on the DO).

For multi-region / multi-process realtime on Vercel / Netlify, plug a
Pub/Sub backend (Redis, NATS, Cloudflare DO + service-to-service) — not
yet shipped.

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

Free-form channel names (anything not under `items:*`, `collections`, or
`presence:*`) are open — no auth, no filter. Useful for chat-like or
notification fan-out where you don't need a permission-bound feed.
Publishes are rate-limited per `(channel, ip)` via `lib/rate-limit.ts`.

## Presence channels (`presence:*`)

Any signed-in user can `GET /api/realtime/presence:<name>/subscribe`.
The server tracks who is currently subscribed to that channel and
broadcasts the roster on each join / leave. There is no external
publish endpoint; the server is the only writer.

```ts
const es = new EventSource("/api/realtime/presence:room-42/subscribe", {
  withCredentials: true,
});
es.addEventListener("message", (ev) => {
  const e = JSON.parse(ev.data); // { event: "presence", data: { members: [...] } }
});
```
