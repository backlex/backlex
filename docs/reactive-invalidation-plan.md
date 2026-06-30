---
title: Reactive invalidation — design plan
description: Staged plan to upgrade realtime from broadcast-and-filter to read-set-tracked recompute. Design proposal, not shipped behavior.
---

> **Status: design proposal.** This is the implementation plan for the deferred
> "read-set-tracked reactive invalidation" item in [Performance](/performance/).
> Nothing here is live yet. It exists so the work can start from a grounded
> design instead of a blank page.

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

## Stage 1 — attach the query filter to the subscription (server-side narrowing)

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

## Stage 2 — server-computed membership transitions (enter / leave / update)

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

## Stage 3 — windowed correctness via the keyset boundary

**Goal:** make `limit`-windowed live queries exact without a refetch on the
common path. A window is `filter + sort + limit`; the open question on any
insert/enter is "does this row belong *inside* the current window, and does that
evict the last row?".

**Changes:**
- Each windowed subscription tracks its **boundary tuple** — the `(sort…, id)`
  value of the last row currently in the window. This is exactly the keyset
  cursor from `services/items/keyset.ts`; reuse `keysetWhere`'s comparison logic
  in-memory (a small `compareBySort(row, boundary, sort)` helper).
- On an `enter`/`update` whose sort key is **beyond** the boundary → ignore (it's
  off-window). **Inside** the boundary → admit + emit an `evict(boundaryId)` so
  the client drops the row that fell off the end; advance the boundary.
- Only fall back to a debounced refetch when the boundary itself is the row that
  left (the new last-row is unknown) — bounded and rare.

**Effort:** M–L. **Risk:** medium — off-by-one window math; needs property tests
(walk a stream of random inserts/updates/deletes, assert the live window always
equals a fresh query). The keyset infra + its tests are the safety net.

## Stage 4 — full read-set registry + transaction-log overlap (true Convex model)

**Goal:** the general engine — a per-isolate/DO **query registry** of active
`LiveQuerySpec`s, and on each commit walk the change set once and check overlap,
recomputing only affected specs. Subsumes Stages 1–3 and adds cross-field /
index-range precision.

**Changes:**
- `LiveQuerySpec = { collection, filter, sort, limit, offset, authSubject }` —
  the read-set descriptor (reuse `ParsedQuery`).
- **Workers:** the Durable Object already holds per-socket meta + a recent-event
  log (`realtime-room.ts:4`); promote that to the registry and run overlap there
  (co-located compute + state, single-threaded — ideal).
- **Serverless (Redis):** stateless, so the registry can't live in memory across
  requests; the overlap check stays per-connection (Stage 1–3 already do this at
  the SSE read loop). Stage 4's registry is a **Workers-only** enhancement; the
  Redis path tops out at Stage 3, which is acceptable (the audit already treats
  serverless realtime as the lower-tier transport).
- Tap the **changefeed** (`(updated_at, id)` log) as the commit source so the
  overlap walk is dialect-agnostic and replayable on reconnect.

**Effort:** L (multi-week). **Risk:** high — new engine, OCC-style overlap
semantics, registry lifecycle/GC. Only justified once Stages 1–3 are in
production and profiling shows the per-connection re-evaluation is the
bottleneck.

## Sequencing & payoff

| Stage | Effort | Win | Transports | Locally testable |
|---|---|---|---|---|
| 1 — server filter | S | fan-out ↓ (most of it) | both | yes (matchesCondition) |
| 2 — transitions | M | exact deltas, no client re-match | both | yes (in-process) |
| 3 — window boundary | M–L | windowed exactness, few refetches | both | yes (property tests) |
| 4 — registry engine | L | general precision at scale | Workers only | partial |

Stages 1–2 are the 80/20: they deliver the bulk of the value by reusing
`matchesCondition` + the existing emit chokepoint, are fully testable in the bun
harness, and ship on both transports. 3 hardens windowed queries on the back of
the keyset work. 4 is the genuine Convex engine — defer until 1–3 are proven and
profiled.

**Invariant to hold throughout:** the combined predicate is always
`AND(permission conditions, query filter)`, evaluated with the subscriber's own
`authSubject`. The query filter narrows; it must never *widen* past what
permission already allows. The before-row (Stage 2) is server-only and stripped
before any client write.
