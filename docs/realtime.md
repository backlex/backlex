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
| anything else       | **a rule**    | no           | [Broadcast channels](/docs/broadcast-channels) — your application's own pub/sub |

System channels (`items:*`, `collections`, `presence:*`) reject external
publish — events come from the API itself when CRUD routes fire (or, for
presence, on join/leave).

Any other channel name is an **application-owned** channel, authorized by a
pattern-matched rule (`/api/admin/realtime-channels`). A name with no matching
rule is refused in both directions; see
[Broadcast channels](/docs/broadcast-channels) for the pattern grammar,
presence and retained history — and for `REALTIME_OPEN_CHANNELS=1`, the
opt-in that restores the pre-rule behaviour where those channels were open to
anyone. Publishing is `POST /api/realtime/<channel>/publish`, rate-limited
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
| Vercel Functions (Node 22)          | SSE, or Ably signals | With `UPSTASH_REDIS_REST_*`: a Redis Stream per channel, subscribe as a bounded long-poll. With only `ABLY_API_KEY`: the [signal-only data plane](#signal-only-data-plane-signalitemsslug) below. With neither: nothing — each stateless instance gets its own Map. |
| Netlify Functions (Node 22)         | SSE, or Ably signals | Same as Vercel.                                                                                                   |

The server still chooses different fan-out paths under the hood (in-proc
Map on Bun, Durable Object on Workers), but every subscriber sees the
same SSE wire format: `data:` frames carrying JSON, `id:` carrying a
monotonic per-channel `seq`, `: ping` keep-alives every 25 s.
Reconnecting clients with `Last-Event-ID` replay the gap (bounded ring
buffer on Bun, `storage`-backed log on the DO).

## Signal-only data plane (`signal:items:<slug>`)

On Vercel / Netlify Functions there is no Durable Object and no long-lived
process, so the only way to hold an `items:*` SSE stream open is the Upstash
Redis long-poll — which keeps a **function invocation open per subscriber**.
One always-open tab is roughly 130K invocations/month against a 125K free tier,
plus ~3,600 Redis commands per editor-hour. That's not a realtime story you can
ship on a free deployment.

The signal plane fixes the cost by moving delivery off your infrastructure
entirely. With `ABLY_API_KEY` set (and no Durable Object / Upstash), the server
publishes an **ID-only signal** to Ably and the browser is connected to Ably
directly:

```jsonc
// the ENTIRE payload on signal:items:posts
{ "event": "updated", "collection": "posts", "id": "row-1", "at": 1750000000000 }
```

The client then reads the changed rows back through the normal REST list
endpoint. Delivery costs **zero function invocations**; the server pays one
REST publish per write.

### Why no row data — and why filtering still holds

The `items:*` plane renders every event *per subscriber*: permission
conditions, the live-query filter and the field allow-list all run server-side
(`renderItemEvent`). None of that can run inside a hosted pub/sub, which fans
out one payload to everyone — that's exactly why the data plane never moved
there.

So the signal doesn't carry a row; it carries the fact that a row changed. The
read-back is where the gate runs, unchanged:

```
signal in → coalesce the burst → ONE list({ id: { _in: [...] } , ...filter })
          → emit {event, transition, data: row} per row returned
          → any id NOT returned → emit a removal
```

An id that doesn't come back is either not readable by this caller or no longer
matches its query — both mean "drop it", which is exactly what the SSE plane's
`leave` transition means. Passing the subscription's own filter into the
read-back reproduces membership transitions too, including for `$now` / `$user`
filters the client can't evaluate itself.

Bursts are coalesced: a 100-row bulk insert is one read-back, not 100.

### The metadata trade-off

Row data can't leak. What a subscriber *can* still observe is the **id and the
timing** of every change in the collection — including rows a row-level
permission condition would have hidden from it entirely on the SSE plane.

The gate bounds that: a token is issued only to callers whose `read` permission
on the collection is **unconditional** (admins, and roles whose grant carries no
`condition`). Those callers can enumerate every id over REST anyway, so the
signal tells them nothing new. A conditioned role — including a non-admin reader
of a `versioned` collection, who implicitly only sees published rows — is
refused and degrades to no realtime.

Set `REALTIME_SIGNAL_SCOPE=all` to waive the check on deployments where change
timing isn't sensitive.

### Using it

The SDK handles all of this. `subscribe()` and `liveQuery()` probe
`GET /api/realtime/items-config` once per client and pick the transport:

```ts
// identical code on every host — Workers, Bun, Vercel, Netlify
const off = backlex.liveQuery("posts", { filter: { done: { _eq: false } } }, setRows);
```

`ably` is an **optional peer dependency** of the SDK, loaded dynamically and
only on deployments that report `ably-signal`; everyone else stays
dependency-free.

Rolling your own client:

| Step | Call |
|---|---|
| Detect the transport | `GET /api/realtime/items-config` → `{ transport: "sse" \| "ably-signal" \| "off" }` |
| Get a token | `POST /api/realtime/ably-token` `{ channels: ["signal:items:posts"] }` → a signed Ably `TokenRequest`, `clientId` pinned to the session user |
| Listen | Ably channel `signal:items:posts`, message name `signal` |
| Hydrate | `GET /api/items/posts?filter={"id":{"_in":[…]}}` |

Signal channels are **subscribe-only** in the minted capability — a client that
could publish signals could make every other reader refetch rows that never
changed, or miss ones that did. One token can cover both planes at once
(`collab:*` gets `publish` + `subscribe`, `signal:items:*` gets `subscribe`).

On a signal deployment, `GET /api/realtime/items:<slug>/subscribe` returns
`503 UNAVAILABLE` with a pointer here rather than holding open a stream that can
never deliver.

### What it doesn't do

- **No `Last-Event-ID` gap replay.** Ably's own connection recovery covers short
  drops; longer outages heal because every consumer re-reads from the server
  (`liveQuery` refetches), never by replaying a log.
- **Only `items:*`.** `collections`, `presence:*` and free-form channels have no
  signal twin and stay on SSE.
- **Never a downgrade.** A runtime that can already serve full-fidelity SSE —
  Workers, Bun, or a deployment with Upstash configured — keeps it. The signal
  plane only fills the case that was previously `off`.

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
