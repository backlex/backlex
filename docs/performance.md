---
title: Performance
description: What Backlex does to keep reads fast, and the optimization backlog.
---

This page records the read-path performance work: what's shipped, why it's
fast, and the deliberately-deferred items (with the path to finish each). It
came out of a 2026-06 audit that cross-referenced Backlex's own hot paths
against the tricks Supabase / PocketBase / Appwrite / Firestore / Convex and
the Cloudflare platform use.

The guiding split: Backlex runs on **D1/SQLite *and* Postgres**, so the wins
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

### D1 read replication via the Sessions API

GET reads on the D1 path are served from the nearest replica. `app.ts` opens a
**per-request** Sessions-API client (`createD1SessionClient`, exported from
`@backlex/db/sqlite`) and hands the request's `ctx.db` to it, so route handlers
read through the session while the base `Ctx` — and the better-auth instance it
carries — stays bound to the original binding, keeping auth writes on primary.

Read-your-writes survives across requests because the bookmark round-trips: the
middleware reads `x-d1-bookmark` off the request (falling back to
`first-unconstrained`, which lets Cloudflare pick the nearest replica when there
is no anchor), and stamps `session.getBookmark()` onto the response after
`next()` so a downstream handler cannot clobber it. The admin client sends it
back on the following request (`client/lib/api.ts`). Mutations route to primary
whatever the constraint is.

The SDK deliberately does **not** carry the bookmark — see
[Architecture → Why the admin keeps its own client](/architecture/).

### Read-set-tracked reactive SSE invalidation

Instead of broadcasting every collection event to every subscriber and filtering
client-side, the server narrows each live query's stream to the events that
actually affect it, so invalidation cost scales with *affected* subscriptions
rather than the total.

A live query's `filter` is evaluated server-side, so a subscription only receives
matching events; membership transitions (`enter` / `leave` / `update`) are
computed on the server, so an update that pushes a row out of the result set is
still delivered rather than silently dropped; and windowed live queries skip the
reconcile refetch on inserts. All three are wired into the SDK `liveQuery`. They
share the in-memory `matchesCondition` evaluator at the emit chokepoint, so both
transports (the in-process / Redis fan-out and the Durable Object socket path)
apply identical rules.

### Already in place (verified during the audit)

- **Per-isolate caches** — collection metadata (`(tenant, slug)`, 30s TTL),
  single-collection rows, session, and per-request permission L1. Warm isolates
  skip the metadata round-trip.
- **Batched to-many expands** — `relation_many` expands collect ids across the
  page and fetch in one `IN (…)`, no per-row N+1.
- **PG read replicas** — `ctx.dbRead` routes reads to `DATABASE_REPLICA_URL`
  when set, on the runtimes that run Postgres (Bun / Node / Vercel / Netlify).
  Not Workers: the Workers bundle ships no Postgres driver, so Hyperdrive is
  refused there rather than half-working — see
  [Deployment](/deployment/) footnote 6.
- **`postgres-js` runs `prepare:false`** — required behind a transaction pooler
  (PgBouncer, Supabase's pooler, Neon's pooled endpoint).
- **Aggressive code-splitting** — GraphQL, SAML, libSQL, CodeMirror, xyflow,
  QuickJS are lazy chunks kept out of the Worker cold-start eval path; adapters
  are constructed lazily and memoized per isolate.
- **FTS** — Postgres `tsvector` + GIN, SQLite FTS5 shadow tables.

### Typecheck: incremental state, and where the eight minutes actually went

The pre-push gate took ~8 minutes, and `typecheck` was the whole of it — the
other three jobs run in parallel and finish inside a minute. The assumption was
that `tsc` was reading too many files. `--extendedDiagnostics` says otherwise:

| | |
|---|---|
| I/O read | 0.48s |
| Parse | 0.90s |
| Program construction | 1.83s |
| **Check** | **126.58s** |

7.3M types and 23.4M instantiations for 182k lines of TypeScript, in 6.3 GB of
memory. It is a type-checking problem, not a file-reading one.

Two things came out of that:

**`incremental` per project.** The work was redone from scratch every run. With
a state file the whole-repo typecheck goes **217s → 17s** when nothing changed,
and `apps/web`'s server project alone **191s → 3s**. A real edit to one route
still costs ~110s (see below for why). CI keeps the state in a cache keyed on
the commit, so a run starts from the previous one.

**TypeScript 6.0.** Free on top: cold whole-repo **217s → 145s**. The only
migration cost was `baseUrl` in four tsconfigs, removed rather than silenced
with `ignoreDeprecations` — the option stops working in 7.0 either way, and
`paths` has not needed it since 4.1.

#### The real bottleneck: long `.openapi()` chains

Attributing check time per file, without double-counting nested spans:

| File | Check time | Share |
|---|---|---|
| `routes/booking.ts` | 31.7s | 20.4% |
| `routes/scim-admin.ts` | 10.4s | 6.7% |
| `routes/roles/users.ts` | 10.4s | 6.7% |
| `routes/payments.ts` | 7.8s | 5.1% |

All of them are long `.openapi(createRoute({…}), handler)` chains. Every link
widens the router's generic type, so cost grows super-linearly with chain
length — which is also why touching one route invalidates so much of the
incremental build.

##### Splitting the chains — attempted 2026-08-15, and it did not work

The obvious fix is to break the longest chains into sub-routers, the way
`routes/items/` already is. It was tried on `routes/booking.ts`: one 15-link
chain became `booking/resources.ts` (7) plus `booking/bookings.ts` (8), mounted
through `.route("/", …)`. The refactor itself was sound — the generated OpenAPI
document came out **byte-identical**, and all 114 booking tests passed. It was
then reverted, because the numbers say it buys nothing:

| | before | after |
|---|---|---|
| Instantiations | 29,469,305 | 29,440,411 (**−0.098%**) |
| Types | 9,050,964 | 9,052,479 (**+0.017%**) |
| Check time | 560.19s | 368.77s |
| max RSS | 2.41 GB | 4.14 GB |

**Read the first two rows, not the third.** `Instantiations` and `Types` are
deterministic counts of the work the checker performed; they do not depend on
how much RAM the machine happened to have. Neither moved. The 34% drop in wall
`Check time` came with max RSS nearly doubling — the second run simply got more
physical memory and paged less. That is the same effect the baseline's
`sys` 316.82s against `user` 138.62s was already reporting: **on this 8 GB
machine more than half of the wall clock is paging, not compiling.**

So chain length is not the lever it looks like, at least at 15→7+8 on this
tree. Don't re-attempt it on `routes/integrations.ts` (26 links) expecting a
win. The lever that is actually measurable here is physical memory — the same
constraint that makes the TypeScript 7 port slower rather than faster below.

#### TypeScript 7 (the Go port) — measured, not adopted

`typescript-7` is installed under an alias and wired to `bun run
typecheck:native` so this stays reproducible. Both compilers report identical
diagnostics on this tree. The speed is not uniform:

| Project | tsc 6.0 | TS 7.0.2 native | |
|---|---|---|---|
| `packages/core` | 0.49s | 0.25s | 2× faster |
| `apps/web` client | 9.15s | 1.61s | **5.7× faster** |
| `apps/web` server | 152s | 268s | **1.8× slower** |

The regression is the one project whose working set (6.3 GB) does not fit
alongside everything else on an 8 GB machine — its `sys` time is 449s against
125s, which is swap, not compilation. So the port is a large win everywhere
except the project that most needs it, on this hardware. A 16 GB CI runner may
well invert that; the script is there to find out.

`apps/docs` and `apps/site` cannot move regardless: they typecheck through
`astro check`, which imports the compiler API, and 7.0 shipped without one.
That returns in 7.1.

#### The heap cap is load-bearing — do not lower it

`apps/web`'s typecheck runs the server pass under
`NODE_OPTIONS=--max-old-space-size=8192`. On an 8 GB machine that looks absurd,
and lowering it is the obvious first thing to try. It was tried (2026-08-15,
cold, idle):

| cap | result | wall | user | sys | peak RSS |
|---|---|---|---|---|---|
| 8192 | ok | 338.56s | 134.19s | 319.18s | 2.28 GB |
| 4096 | **OOM**, exit 134 | 67.66s | 109.85s | 58.50s | 4.01 GB |
| 2048 | **OOM**, exit 134 | 20.77s | 50.15s | 1.91s | 2.37 GB |

The live heap really does exceed 4 GB — the 4096 run died with peak RSS sitting
exactly on its ceiling. The flag is not slack to be reclaimed; it is the only
thing keeping the pass alive.

#### Why `pre-push` is serial

Same session, same machine, cold cache, nothing else running:

| | `parallel: true` | serial |
|---|---|---|
| gate total | 695s | 715s |
| typecheck | 695s | 327s |
| test | 657s | 388s |
| **total `sys`** | **707s** | **292s** |

Serialising does not shorten the gate: parallel's total is its longest job,
serial's is the sum, and the two land 20s apart — noise here. Each job roughly
halves on its own, and that cancels out.

What changes is the last row. Since typecheck needs >4 GB of live heap, running
it beside the test suite pushes the machine into swap; `test`'s `sys` time alone
falls 241s → 33s once nothing is competing with it. That contention is the same
mechanism that once left two overlapping typechecks wedged in `U` state for 27
minutes, paging rather than compiling, converging on nothing. So the gate is
serial for stability, not speed — identical wait, machine still usable while it
runs. Jobs are ordered cheapest-first so a failure costs seconds rather than
twelve minutes.

**Methodology note, worth more than any single number above:** wall time on this
box swings ~40% for provably identical work — the same config on the same tree
produced `real` 560.19s and 338.56s while `user`, `sys` and `Instantiations`
(29,469,305, to the digit) barely moved. Compare `user` / `sys` /
`Instantiations`. Never compare `real`.

### Admin first paint: 659 KB → 157 KB gzip

The admin SPA used to ship 616 KB gzip of JavaScript (plus 44 KB of CSS) before
it painted anything, and it shipped the same bytes to everybody. Four changes,
each removing a different reason the bundle could not split:

**The router had no lazy boundary.** Every route element in `App.tsx` was a
static import — including `AdminApp`. So a stranger opening a public booking
link or a form (`/book/<token>`, `/f/<token>`) downloaded the whole admin
console to render a page deliberately built not to look like one. Every route
is now `lazy()`. A public form's entire graph is 97 KB gzip and reaches no admin
code at all.

The admin itself is the case a naive split would have made *slower*:
`<AuthGate>` spends a network round-trip deciding whether there is a session,
and a chunk that starts downloading only after that answer is a second
round-trip stacked on the first. The catch-all route therefore warms the admin
chunk from render, before the gate has an answer, so the two overlap.

**The English catalog was a runtime dependency.** Lingui's macro defaults to
`descriptorFields: "id-only"` in production: `<Trans>Save</Trans>` compiles to
`<Trans id="gkzAEM"/>` and the readable text survives only in the compiled `en`
catalog — one 92 KB gzip module, loaded before first paint by everyone,
including that booking-link visitor who needs four strings from it. A catalog
cannot be code-split (message ids are content hashes with no route to group them
by). Setting `descriptorFields: "message"` keeps the English beside the
component instead, so the strings split themselves along the code, and `en` has
no runtime catalog at all. Translated locales are unchanged — `tr` still loads
its `.po` as a lazy chunk.

**One `manualChunks` function served two builds that want opposite things.** Its
default — pin every remaining `node_modules` module into a single eager `vendor`
chunk — is reasonable for the Worker (one entry, no route graph) and wrong for
the browser by construction: a lazily-reached package gets nailed into a chunk
something eager already pulls, undoing the `import()`. Each leak had been fixed
by hand-adding another exception, twelve of them. `react-day-picker` +
`date-fns` (~300 KB raw, reachable only from the date field editor) were the
ones nobody had caught yet. The function is now split per environment: the
client pins React and leaves the rest to the import graph, which is what all
twelve exceptions were approximating one package at a time; the Worker keeps its
pin and every server-side exception, and its output is byte-identical.

**Pinning Radix split React.** With `radix-vendor` pinned, some react modules
were assigned to it — a module can only live in one chunk — which made a chunk
named after a component library a hard dependency of anything that renders
anything. Unpinned, React is whole and Radix travels with the lazy chunks that
use it. Total bytes across the whole build are unchanged (1286 KB gzip either
way); only the timing changed. The last thing holding Radix in the eager graph
was a single `<TooltipProvider>` at the app root, now mounted inside the lazy
admin chunk — nothing outside the admin renders a tooltip.

Two rules in `tests/client/admin-ui-conventions.test.ts` keep it: the router may
not import a page eagerly (and everything it renders must be `lazy()`), and the
eager shell may not import admin-only UI. Both were verified to fire.

| | before | after |
|---|---|---|
| first paint, total | 659 KB gz | **157 KB gz** |
| first paint, JS only | 616 KB gz | **123 KB gz** |
| eager chunks | 35 | 21 |
| a public form's whole graph | 616 KB gz | **97 KB gz** |
| whole build | 1286 KB gz | 1286 KB gz |

## Deferred (scoped, with rationale)

These were evaluated and intentionally left for a follow-up — each needs an
environment the test harness can't provide, a product/UX decision, or is a
multi-week project. They are decisions, not forgotten TODOs.

> Two items that used to sit here have since shipped and moved up into
> **Shipped**: D1 read replication via the Sessions API, and read-set-tracked
> reactive SSE invalidation. Don't re-plan them.

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

