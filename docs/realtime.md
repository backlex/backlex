---
title: Realtime
description: Permission-aware change feed over SSE, with a Durable Object bridge on Workers.
---

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

### How a subscription authenticates

`EventSource` **cannot set request headers** — there is no way to attach an
`Authorization: Bearer` token to it. Subscriptions therefore authenticate by
**cookie**, which is why `withCredentials: true` above is mandatory rather than
decorative.

| Caller | Cookie it sends |
|---|---|
| Admin / control plane | the platform session cookie |
| Workspace end-user (app plane) | `wo_<tenantSlug>.session_token`, set on every end-user sign-in — httpOnly, `SameSite=Lax` |

The practical consequence: **realtime needs the API to be same-origin with your
app.** A `SameSite=Lax` cookie is not sent to a different site, so a genuinely
cross-origin SPA gets a `401` on subscribe even though its `fetch` calls work
fine (those carry the bearer). Serve the API under your own origin — a dev proxy
locally, a path or subdomain-with-shared-site in production — and subscriptions
authenticate with no extra work.

Public channels (`public:*`, `presence:*`, `collab:*`) are open and need none of
this.

Or via the SDK:

```ts
import { createClient } from "backlex";
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

| Host                                | Client transport   | Server fan-out                                                                                                  |
|-------------------------------------|--------------------|------------------------------------------------------------------------------------------------------------------|
| Bun (self-host)                     | SSE                | In-process `Map<channel, Set<Subscriber>>` + a bounded per-channel ring buffer for replay. Single-instance only. |
| Cloudflare Workers                  | SSE                | SSE response bridged into the `RealtimeRoom` Durable Object (WebSocket Hibernation API; `seq` + recent-event log persisted in `state.storage`). |
| Vercel Functions (Node 22)          | SSE                | Loads but impractical: Lambda is stateless, so each cold-started function instance gets its own Map; the SSE stream also caps at the function execution limit. |
| Netlify Functions (Node 22)         | SSE                | Same caveat as Vercel.                                                                                            |

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

Free-form channel names (anything not under `items:*`, `collections`,
`presence:*`, or `collab:*`) are open — no auth, no filter. Useful for
chat-like or notification fan-out where you don't need a permission-bound
feed. Publishes are rate-limited per `(channel, ip)` via `lib/rate-limit.ts`.

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

## Collaboration channels (`collab:list:<slug>`)

The admin's live-collaboration layer (who's viewing a record, who's editing
which field — in the editor header AND on the items table's "Live" column).
Collab rides **one channel per collection**: every editor message carries its
record id in the body (`item`), the record editor filters the stream on it,
and the list view groups rows by it — a 50-row table costs one subscription
instead of fifty. The legacy per-record shape (`collab:item:<slug>:<id>`)
still parses for older SPA bundles mid-deploy, but nothing publishes to it.

Both subscribe **and** publish require a session plus `read` permission on
the collection. Publish bodies are schema-validated
(`{ t: "hello"|"focus"|"blur"|"ping"|"bye", item?, field? }` — strict, a
client-supplied `user` is rejected) and identity is stamped server-side from
the session, so members can't impersonate each other.

The protocol is stateless: there is no server-side roster. Every client
derives the member list from the stream (15s `ping` heartbeats, 45s TTL
sweep), and editors reply to any `hello` with a jittered `ping` — so the
messages ride any fan-out transport without membership state. A list view
announces itself with a single **observer hello** (no `item`): editors answer
with their state, the observer never publishes again, and observers are never
added to rosters — an open table costs nothing recurring.

`GET /api/realtime/collab-config` tells the SPA which pipe to use:

| Transport | When | How |
|---|---|---|
| `native` | Durable Object, long-lived process (Bun), or the Upstash Redis fallback | SSE subscribe + REST publish above |
| `ably` | Stateless serverless with `ABLY_API_KEY` set | Browser connects to Ably directly with a server-minted, channel-scoped TokenRequest (`POST /api/realtime/collab-token`, `clientId` pinned to the session user). Zero function invocations for delivery — the free-tier-friendly path on Vercel/Netlify. |
| `off` | Stateless serverless with neither key | The admin hides collab affordances |

The Ably key (`ABLY_API_KEY`, `keyName:keySecret` form) never reaches the
client; the server only signs token requests (WebCrypto HMAC, no SDK in the
server bundle). On the Ably pipe, receivers trust the Ably-verified
`clientId` over the message body — only the display name is self-reported.
