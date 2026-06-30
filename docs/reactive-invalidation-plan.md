---
title: Reactive invalidation — design plan
description: Staged plan to upgrade realtime from broadcast-and-filter to read-set-tracked recompute. Design proposal, not shipped behavior.
---

> **Status: Stages 1–3 shipped; Stage 4 designed + deferred.** This is the
> staged plan for the "read-set-tracked reactive invalidation" item in
> [Performance](/performance/). Server-side query filtering (1), server-computed
> membership transitions (2), and refetch-free windowed maintenance (3) are live
> and wired into the SDK `liveQuery`. Stage 4 turned out to be mostly subsumed by
> the per-event per-subscription model; its one genuine remaining piece
> (server-pushed window backfill) is stateful + Workers-only + needs live
> verification, so it's designed but not built.

## The idea (Convex, adapted)

Convex makes live queries cheap and exact by tracking each query's **read set**
(the rows + index ranges it touched) and, on a write, recomputing **only** the
subscriptions whose read set the write overlaps. Invalidation cost scales with
*affected* subscriptions, not total. backlex's realtime today is
**broadcast-and-filter**: every item event for a collection is fanned out to
every subscriber of that collection, which then drops the ones that don't match
its permission. A live query with `filter: {done:false}` still *receives* every
todo event and re-checks it client-side.

The good news from the code audit: **backlex already has most of the
primitives.** The plan is to reuse them, not rebuild.

## What already exists (reuse, don't rebuild)

- **The in-memory predicate evaluator** — `matchesCondition(row, condition,
  authSubject, {now})` in `packages/db/src/permission.ts:354`. This IS the
  read-set overlap primitive: "does this changed row satisfy this filter?" It
  already resolves `$user.*` / `$tenant.id` / `$now` and relative dates, and
  does snake/camel key lookup.
- **Per-subscriber filtering at emit time** — `passesFilter` /
  `renderEventForMeta` in `apps/web/src/server/services/events.ts:58,93`, and
  the Durable Object's per-socket `deliver()` in
  `apps/web/src/server/durable-objects/realtime-room.ts:227`. Both already
  evaluate `SubscriptionMeta.conditions` (the caller's *permission* conditions)
  against the event row. There is exactly ONE place per transport to add the
  query filter.
- **The subscription descriptor** — `SubscriptionMeta` (`events.ts:18`) already
  rides along per socket (DO `serializeAttachment`) / per SSE connection. It
  carries `authSubject`, `conditions`, `fields`. We extend it.
- **The event payload** — `ItemEventPayload { event, data: fullRow }`
  (`events.ts:13`), published from the items write path as `items:<slug>`.
- **The keyset cursor** — the `(sort…, id)` boundary tuple shipped for keyset
  pagination (`services/items/keyset.ts`) is exactly the "index-range" boundary
  a windowed (`limit`) live query needs to decide admit/evict.
- **The changefeed** — `GET /items/{slug}/changes?since=` keyset-walks
  `(updated_at, id)` with full-row + tombstones: the per-row transaction log a
  full registry-based engine would tap.
- **Client-side incremental maintenance** — the SDK `liveQuery` already inserts
  on match / removes on miss / refetches the window edge (`docs/reactive-queries.md`).

What's missing: the query filter isn't attached to the subscription
(server filters on *permission* only), the server never computes a membership
*transition* (it ships the raw row, the client re-derives), and there's no
window-boundary tracking. Those are the four stages below.

## Stage 1 — attach the query filter to the subscription (server-side narrowing) ✅ shipped

**Goal:** a filtered subscriber receives only events whose row matches its
filter, evaluated server-side with the existing predicate. Pure fan-out
reduction; the read set = the query filter, the overlap check = `matchesCondition`.

**Changes:**
- Subscribe protocol: accept an optional `filter` (canonical `Condition`) on the
  realtime subscribe call (`routes/realtime.ts` gate). Validate + `normalizeCondition`
  it exactly like `parseQuery` does (`lib/query.ts`), against the collection's
  fields + the caller's read field allow-list (so a filter can't probe a column
  the caller can't read).
- `SubscriptionMeta` gains `queryFilter: Condition | null` (`events.ts:18`).
- `passesFilter` (`events.ts:58`) and the DO `deliver()` condition check
  (`realtime-room.ts:227`) AND the query filter into the existing evaluation:
  `passesPermission(row) && (queryFilter==null || matchesCondition(row, queryFilter, auth))`.

**Effort:** S. **Risk:** low — narrowing what a subscriber receives is safe
(clients already tolerate a superset and filter locally; Stage 1 just means they
get less noise). Both transports, one chokepoint each. Fully unit-testable
against `matchesCondition` with no D1/Redis. **Win:** most of the bandwidth +
client-CPU savings, immediately.

## Stage 2 — server-computed membership transitions (enter / leave / update) ✅ shipped

**Goal:** for an `updated` event, the server tells the client *what changed
about membership* instead of shipping a raw row the client must re-classify:
did the row **enter** the result set, **leave** it, or **update-in-place**.

**Why it needs the before-row:** membership transition = `matches(before,
combined)` vs `matches(after, combined)`, where `combined = AND(permission
conditions, queryFilter)`. Today `publishEvent` ships only the AFTER row.

**Changes:**
- The items update path already loads the row; thread the pre-write row into the
  publish as `ItemEventPayload.before?` (`events.ts:13`, items write path). It is
  **server-only** — used to compute the transition, then stripped; never sent to
  a client (it could contain fields the subscriber can't read).
- At emit, per subscriber compute:
  - `before` no / `after` yes → `enter` (send projected row)
  - `before` yes / `after` no → `leave` (send id only)
  - both yes → `update` (send projected row)
  - both no → drop
- Emit a typed delta `{ type: "enter"|"leave"|"update"|"delete", id, data? }`.
  `created`→enter-or-drop, `deleted`→delete.
- SDK `liveQuery` consumes the typed delta directly (drops its local re-match
  for the non-windowed case).

**Effort:** M. **Risk:** medium — must guarantee the before-row never leaks
(strip before any client write; the projection/permission gate still runs on the
sent row). Testable end-to-end against the in-process transport.

## Stage 3 — windowed correctness via the keyset boundary ✅ shipped

**Goal:** make `limit`-windowed live queries exact without a refetch on the
common insert path. A window is `filter + sort + limit`; the question on any
insert is "does this row belong *inside* the current window, and does that evict
the last row?".

**Shipped (client-side, `live.ts`):** the engine tracks the boundary implicitly
as the last visible row and compares an incoming row to it via the existing
`compareRows`:
- new row sorts **after** the boundary → off-window → dropped, **no refetch**;
- new row sorts **in-window** → inserted + the overflow row evicted (now
  off-window, correctly hidden), **no refetch**;
- insert into a non-full window → inserted, no refetch.

Still reconciles (an uncached off-window row may need to slide in): a **removal**
from a full window, and an **update that moves** a visible row toward a full
window's edge. An update that doesn't change the sort key no longer refetches.
Result: the common insert path on an infinite-scroll / top-N view goes from one
refetch per event to zero.

## Stage 4 — read-set registry + server-pushed window backfill

**Implementation finding (after building 1–3):** for backlex's **per-event**
architecture, "recompute only affected subscriptions" is *already what Stages
1–2 do*. Every event is matched against each subscription's read-set
(`conditions` + `queryFilter`) at the single emit chokepoint (`renderItemEvent`),
and only overlapping subscriptions receive it. The Durable Object's set of
sockets-with-meta **is** the query registry; `matchesCondition` **is** the
overlap check. There is no batch transaction log to walk — each event already
triggers exactly the per-subscription overlap evaluation a registry engine would
schedule. So a separate "registry + transaction-log overlap" engine would be
largely **redundant** here (it's the right model for Convex's batched-commit
core, not for a per-event publisher).

**The one genuine remaining capability:** eliminate the *last* refetch — when a
row leaves a full window, Stage 3 still refetches to pull the next off-window
row, because the client doesn't cache it. A true Stage 4 would have the **server
push that next row**: it must hold each subscription's window state (sort +
limit + current boundary) and, on a removal, run one keyset query
(`WHERE (sort…, id) > boundary LIMIT 1`) and emit a `backfill` delta.

**Why it's deferred (design complete, not built):**
- It requires **stateful, per-subscription server state** (the boundary), which
  backlex deliberately avoids — the realtime publisher is stateless so live
  queries work identically across every supported runtime and deploy target.
- It's **Workers/DO-only**: the Durable Object can hold that state
  (`realtime-room.ts` already persists per-socket attachments + an event log);
  the stateless Redis/serverless transport structurally can't, so it would stay
  at Stage 3 there.
- It's **not exercisable in the bun harness** (no DO), so it would ship to the
  cloud fleet unverified — the same constraint that defers D1 Sessions (see
  [Performance](/performance/)). It must be verified on a live Worker before
  merge.

**Sketch:** on subscribe the DO records `{ sort, limit, boundary }` per socket
(boundary seeded from the client's first page or a `?boundary=` cursor); on a
`leave`/`delete` that empties a window slot, the DO runs the keyset backfill
query (it already has `ctx`-less access via a fetch to the API, or a passed-in
binding) and sends a `backfill` event the SDK splices in — retiring the Stage 3
remove-refetch.

## Sequencing & payoff

| Stage | Status | Win | Transports | Locally testable |
|---|---|---|---|---|
| 1 — server filter | ✅ shipped | fan-out ↓ (most of it) | both | yes (matchesCondition) |
| 2 — transitions | ✅ shipped | exact deltas, no client re-match | both | yes (in-process) |
| 3 — window boundary | ✅ shipped | windowed exactness, no insert refetch | both | yes |
| 4 — window backfill | design complete, deferred | retire the last (remove) refetch | Workers only | needs live DO |

Stages 1–3 are shipped and deliver the bulk of the value, reusing
`matchesCondition` + the existing emit chokepoint, fully tested in the bun
harness, on both transports. Stage 4's separate "engine" turned out to be mostly
subsumed by the per-event per-subscription model; its one real remaining piece
(server-pushed window backfill) is stateful + Workers-only + needs live
verification, so it's designed but deferred — matching how D1 Sessions is
handled.

**Invariant to hold throughout:** the combined predicate is always
`AND(permission conditions, query filter)`, evaluated with the subscriber's own
`authSubject`. The query filter narrows; it must never *widen* past what
permission already allows. The before-row (Stage 2) is server-only and stripped
before any client write.
