---
title: Reactive queries
description: Subscribe to a query, not a channel — a result array that stays consistent as data changes, with zero client reducer boilerplate.
---

A **reactive query** (a.k.a. live query) subscribes to a *query* — a collection
plus filter / sort / limit — and keeps its result array consistent as the
underlying data changes. You get the initial page, then a fresh array on every
relevant change. No manual event wiring, no stale data, no hand-written
"on created insert, on deleted splice" reducer.

It builds on [realtime](/realtime): backlex already streams permission-filtered
per-row events over `items:<slug>` SSE. A reactive query layers query-level
maintenance on top of that stream — entirely in the client, so the server stays
a stateless event publisher and live queries work on **every runtime** (Bun,
Workers, Vercel, Netlify) with no per-subscription server state.

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

## Permission & tenant scope

A reactive query inherits the realtime feed's guarantees: you only ever receive
events for rows you can read, already field-projected to your permission
allow-list. The initial `list()` and every refetch apply the same read gate. A
reactive query can never surface a row the caller couldn't fetch directly.

## In the admin

The admin's collection item list is itself a reactive query: a **Live** badge
appears while the realtime channel is connected, and the table refreshes as rows
change — from another tab, another admin, the SDK, or a [flow](/flows).

## Not covered

Reactive queries are an SDK + realtime concern, so they have no GraphQL / MCP /
CLI surface (those are request/response). Aggregates aren't reactive — use a
`liveQuery` over the rows and reduce client-side, or refetch the aggregate on a
`liveQuery` change. Server-side incremental view maintenance (a true materialized
reactive cache) is a possible future direction; today the maintenance is
client-side, which is what keeps it stateless and runtime-portable.
