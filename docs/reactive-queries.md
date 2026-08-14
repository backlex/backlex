---
title: Reactive queries
description: Subscribe to a query, not a channel — a result array that stays consistent as data changes, with zero client reducer boilerplate.
---

A **reactive query** (a.k.a. live query) subscribes to a *query* — a collection
plus filter / sort / limit — and keeps its result array consistent as the
underlying data changes. You get the initial page, then a fresh array on every
relevant change. No manual event wiring, no stale data, no hand-written
"on created insert, on deleted splice" reducer.

It builds on [realtime](/realtime): Backlex already streams permission-filtered
per-row events over `items:<slug>` SSE. A reactive query layers query-level
maintenance on top of that stream — entirely in the client, so the server stays
a stateless event publisher and live queries ride on **whatever realtime
transport the deployment provides** (in-process SSE on Bun / Node / Deno,
Durable Objects on Cloudflare, or Redis Streams on stateless serverless), with
no per-subscription server state — so they work on any of Backlex's supported
[deploy targets](/deployment).

## SDK

```ts
import { createClient } from "backlex";
const backlex = createClient({ url: "https://api.example.com" });

const stop = backlex.liveQuery(
  "todos",
  { filter: { done: { _eq: false } }, sort: "-created_at", limit: 50 },
  (rows) => render(rows),          // called with the initial page, then on every change
  (err) => console.error(err),     // optional
);

// later
stop();
```

`liveQuery(slug, opts, onResult, onError?)` takes the same `opts` as
[`list()`](/querying) (`filter`, `sort`, `fields`, `limit`, `expand`, `q`,
`locale`, `status`). `onResult` receives a **new array** each time (safe to set
straight into state). It returns an unsubscribe function.

## React

```tsx
import { useLiveQuery } from "backlex/react";

function Todos({ backlex }) {
  const { data, loading, error } = useLiveQuery(backlex, "todos", {
    filter: { done: { _eq: false } },
    sort: "-created_at",
    limit: 50,
  });
  if (loading) return <Spinner />;
  return <ul>{data.map((t) => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

React is an **optional peer dependency** — importing `backlex/react` is the only
thing that pulls it in. The hook re-subscribes when `slug` or (deep-equal)
`opts` change and unsubscribes on unmount.

## How it stays consistent

For a **simple** query — top-level field filter + sort, no relations or search —
the engine maintains the array **incrementally** in JS:

- **created / updated** matching the filter → inserted (or moved) to its sorted
  position.
- **created / updated** that no longer matches → removed.
- **deleted** → removed.

Most changes need **zero extra round-trips**. The client-side matcher mirrors the
[permission DSL](/permissions) operators, so "matches the filter" means the same
thing it does server-side.

### Server-side narrowing + transitions

When the filter has no nested (`a.b`) keys, the SDK also forwards it to the
realtime subscription (`?filter=`). The server then delivers **only** the events
whose row matches — so the stream carries less, not the whole collection — and
annotates each with a membership `transition` (`enter` / `leave` / `update`) it
computed by evaluating the filter against the row before AND after the write.
The decisive one is **`leave`**: an update that pushes a row out of the result
set is still delivered (the after-row no longer matches) so the client can drop
it. The client trusts the `transition` when present, which is also what lets the
server's resolution of `$user.*` / `$now` drive membership — the client can't
evaluate those in JS. (The server validates the forwarded filter: it must
reference readable, non-relation fields, or the subscription is rejected.)

### Limit windows

With a `limit`, the incremental apply is **optimistic** (instant UI) and a
debounced **reconcile refetch** pulls the exact window — because when a row
leaves a full window, the next off-window row should slide in, and the client
doesn't have it cached. You get snappy feedback plus eventual exactness.

### Refetch fallback

Anything the engine can't safely maintain in JS transparently falls back to a
debounced refetch (always correct, just less incremental):

- `expand` (the related object is computed server-side)
- `q` full-text search (relevance is server-ranked)
- nested `a.b` paths in `filter` or `sort`
- `$now` / `$user.*` values in the filter (resolved server-side)

Bursts of events (e.g. a batch write) are coalesced into a single refetch.

### On stateless serverless: the signal plane

Vercel / Netlify Functions can't hold an SSE stream open cheaply, so a
deployment with `ABLY_API_KEY` (and no Upstash) delivers row events as **ID-only
signals over Ably**, which the SDK hydrates back into ordinary events by reading
the changed rows through REST — with your filter applied, so the `enter` /
`update` / `leave` answers come out the same. `liveQuery` is unchanged: it
probes the transport once and adapts. See
[Signal-only data plane](/realtime#signal-only-data-plane-signalitemsslug) for
the mechanics, the cost argument, and the one thing it trades away (subscribers
observe change *timing*, so the plane is gated to unconditional readers).

## Permission & tenant scope

A reactive query inherits the realtime feed's guarantees: you only ever receive
events for rows you can read, already field-projected to your permission
allow-list. The initial `list()` and every refetch apply the same read gate. A
reactive query can never surface a row the caller couldn't fetch directly. That
holds on the signal plane too — there the read gate simply moves to the
read-back, which is why an id you can't read is reported to the engine as a
removal rather than a row.

## In the admin

The admin's collection item list is itself a reactive query: a **Live** badge
appears while the realtime channel is connected, and the table refreshes as rows
change — from another tab, another admin, the SDK, or a [flow](/flows).

## Not covered

Reactive queries are an SDK + realtime concern, so they have no GraphQL / MCP /
CLI surface (those are request/response). The React binding is
[`backlex/react`](./client-react.md), which wraps `liveQuery` as `useLiveQuery`.

Which subsystems reach the SDK at all — and the written reason for each one
that does not — is a registry in `apps/web/tests/sdk-surfaces.test.ts`. That is
the canonical record of parity exceptions rather than this page: an entry there
costs a sentence of reasoning and names the wave it is revisited in, so an
absent client is a decision on the record instead of a silence. Aggregates aren't reactive — use a
`liveQuery` over the rows and reduce client-side, or refetch the aggregate on a
`liveQuery` change. Server-side incremental view maintenance (a true materialized
reactive cache) is a possible future direction; today the maintenance is
client-side, which is what keeps it stateless and runtime-portable.
