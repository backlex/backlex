---
title: Performance
description: What backlex does to keep reads fast, and the optimization backlog.
---

This page records the read-path performance work: what's shipped, why it's
fast, and the deliberately-deferred items (with the path to finish each). It
came out of a 2026-06 audit that cross-referenced backlex's own hot paths
against the tricks Supabase / PocketBase / Appwrite / Firestore / Convex and
the Cloudflare platform use.

The guiding split: backlex runs on **D1/SQLite *and* Postgres**, so the wins
below are the ones that work on both dialects (or are clearly tagged to one).
PRAGMA tuning and PG connection-pooling/`prepare:false` only touch the
self-hosted-SQLite and Postgres paths — **D1 manages PRAGMAs and concurrency
itself**, so those categories are out of scope on the D1 path.

## Shipped

### Keyset (cursor) pagination — `?cursor`

Offset paging is O(offset): the engine walks and discards every skipped row
before the page window, so deep pages slow linearly and a concurrent insert can
skip/duplicate rows across page boundaries. List endpoints accept an opt-in
`?cursor` that seeks straight past the previous page's boundary tuple via a
composite index, so each page is O(page size) at any depth and stable under
writes. Full reference: [Pagination](/querying/#pagination). Both dialects;
biggest win on D1 (no intra-query parallelism to mask a deep scan).

### Free `has_more` (no COUNT tax)

Every list response carries `has_more`, derived from a `limit + 1` over-fetch —
no extra `COUNT(*)` round-trip. `COUNT(*)` now only runs when `meta=filter_count`
/ `total_count` is explicitly requested. Prefer `has_more` for "is there another
page?".

### Auto-indexing (schema-applier)

The dynamic DDL applier indexes, on create and on every later apply (additive,
`IF NOT EXISTS`):

- every `indexed:true` field;
- **every to-one `relation` FK** — the column every `expand=`, nested filter,
  and nested sort JOINs on (an un-indexed FK is a child-table scan per parent);
- a **`(tenant_id, created_at, id)` composite** (`<table>_keyset_idx`) that
  backs both the default `-created_at` ordering and the keyset seek, so deep
  pages stay index-only;
- plus the existing owner / tenant / status / publish / soft-delete / FTS
  indexes.

A plain ASC btree serves the `DESC` default sort via a backward scan on both
engines. On D1, validate with `EXPLAIN QUERY PLAN` and `wrangler d1 insights`
(D1 bills on rows *read* — aim for `rows returned ÷ rows read ≈ 1`).

### GraphQL relation batching (no N+1)

To-one `relation` fields resolve through a per-request batch loader: a query
returning N parents fires one `WHERE id IN (…)` per target collection, not N
single-row lookups. Same permission/tenant/row-level/soft-delete/draft gates as
a direct fetch; repeated FKs dedupe within the request. See
[GraphQL → Relations](/graphql/#relations).

### Conditional GET (ETag → 304)

Single-item reads and the schema reads (`/api/collections` + `/:slug`) emit a
weak ETag keyed on the row's `updated_at` version (schema reads: a digest of
each row's `(id, updatedAt)`) plus the params that change the body. A matching
`If-None-Match` returns an empty 304 **before** any expand/serialization.
`Cache-Control: private, no-cache` + `Vary: Authorization, Cookie` keeps it
per-user and always-revalidated — never a shared cache. Layers on top of the
existing per-isolate schema cache so even a cache hit can 304.

### Already in place (verified during the audit)

- **Per-isolate caches** — collection metadata (`(tenant, slug)`, 30s TTL),
  single-collection rows, session, and per-request permission L1. Warm isolates
  skip the metadata round-trip.
- **Batched to-many expands** — `relation_many` expands collect ids across the
  page and fetch in one `IN (…)`, no per-row N+1.
- **Hyperdrive** for Postgres-on-Workers — `HYPERDRIVE.connectionString` is
  auto-used when bound, `postgres-js` already runs `prepare:false` (required
  behind a transaction pooler), and a read replica wires in via
  `HYPERDRIVE_REPLICA`. Caveat: the Hyperdrive query cache (default 60s) can
  serve a stale read just after a write — disable caching on the config if you
  need strict read-your-writes. (See `wrangler.toml`.)
- **PG read replicas** — `ctx.dbRead` routes reads to
  `HYPERDRIVE_REPLICA`/`DATABASE_REPLICA_URL` when set.
- **Aggressive code-splitting** — GraphQL, SAML, libSQL, CodeMirror, xyflow,
  QuickJS are lazy chunks kept out of the Worker cold-start eval path; adapters
  are constructed lazily and memoized per isolate.
- **FTS** — Postgres `tsvector` + GIN, SQLite FTS5 shadow tables.

## Deferred (scoped, with rationale)

These were evaluated and intentionally left for a follow-up — each needs an
environment the test harness can't provide, a product/UX decision, or is a
multi-week project. They are decisions, not forgotten TODOs.

### D1 read replication via the Sessions API

**Win:** the biggest global read-latency reduction on the D1 path — GET reads
served from a nearby replica via `env.DB.withSession(constraint|bookmark)`, with
the bookmark threaded response-header → client → next request for
read-your-writes + monotonic reads.

**Why deferred:** a D1 session is **per-request** (`withSession()` is bound to
one request's bookmark), but backlex's `Ctx` — including `db`/`dbRead` — is
built **per-isolate** and memoized (WeakMap on the `Env`). Wiring sessions means
a per-request read-db layer that doesn't fit the current per-isolate model, and
none of it is exercisable in the `bun:sqlite` test harness (no `env.D1`), so it
would ship to the cloud fleet untested. **Plan:** introduce a request-scoped
`dbRead` override (middleware reads `x-d1-bookmark`, calls
`env.D1.withSession(bookmark ?? "first-unconstrained")`, stashes a Drizzle bound
to that session on the request; an `after` hook sets `session.getBookmark()` on
the response), then point read handlers at the request `dbRead`. Verify on a
real D1 with replication enabled (`read_replication.mode=auto`) before merge.

### Admin items table virtualization

**Win:** render only the visible rows of a long list instead of all of them.

**Why deferred:** the list is already paginated (default 50, hard cap 200), so
the DOM cost is bounded and the win is marginal at this scale (the trick really
pays at 10k+ unpaginated rows). The table is a semantic `<table>` with sticky
columns; virtualizing it means either a layout rewrite or switching it to an
internal fixed-height scroll region — a **UX change** (page-scroll → inner
scroll) that needs a design call and the repo's required mobile (~390px) +
desktop verification pass. **Plan:** if pursued, use `@tanstack/react-virtual`
with the spacer-row technique (keeps the semantic table + sticky columns
intact), inside a bounded `ScrollArea`; update `ItemsTableSkeleton` to match;
verify geometry at both breakpoints.

### Read-set-tracked reactive SSE invalidation (Convex-style)

**Win:** replace broadcast-and-filter SSE with surgical invalidation — track
each live query's read set (row ids + index ranges) and, on a write, recompute
only the subscriptions whose read set the write overlaps. Invalidation cost
scales with *affected* subscriptions, not total.

**Status: Stages 1–3 shipped; Stage 4 designed + deferred.** Stage 1 (server-side
live-query filter — the subscription narrows the stream to only matching
events), Stage 2 (server-computed `enter`/`leave`/`update` transitions, so an
update that pushes a row out of the result set is still delivered), and Stage 3
(windowed live queries skip the reconcile refetch on inserts) are live and wired
into the SDK `liveQuery`. They reuse the in-memory `matchesCondition` evaluator
(the overlap primitive) at the existing emit chokepoint, shared across both
transports. Building them revealed that a separate Stage-4 registry/transaction-
log engine is largely **subsumed** by backlex's per-event per-subscription model
(each event already triggers exactly the per-subscription overlap check a
registry would schedule); the one genuine remainder — server-pushed window
backfill to retire the last refetch — is stateful + Workers-only + needs live DO
verification, so it's designed but not built. Full write-up:
[Reactive invalidation — design plan](/reactive-invalidation-plan/).
