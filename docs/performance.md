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
writes. Full reference: [Pagination](/docs/querying/#pagination). Both dialects;
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
[GraphQL → Relations](/docs/graphql/#relations).

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
[Architecture → Why the admin keeps its own client](/docs/architecture/).

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
  [Deployment](/docs/deployment/) footnote 6.
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
with `ignoreDeprecations` — and that call paid off: 7.0 turned the deprecation
into `TS5102: Option 'baseUrl' has been removed`, so a tree that had silenced it
would have had to do the work anyway, under a hard error. (`paths` has not
needed `baseUrl` since 4.1.) The tree has since moved on to 7.0 — see below.

##### One typecheck at a time, across processes — added 2026-08-29

`lefthook.yml` made the pre-push gate serial for a measured reason: run
typecheck beside the suite and the box spends 707s in the kernel instead of
292s. That reasoning only ever applied INSIDE one gate run, and it cannot see
the shape this repo actually has — several agent sessions, each in its own
worktree, each free to start its own `tsc`.

Observed 2026-08-29: four concurrent checker processes, 16% free memory, 559k
pageouts, and a 7-minute job that had not finished at 22 minutes. Nothing was
wrong with any one of them.

`bun run typecheck` now goes through `scripts/typecheck.ts`, which holds an
exclusive lock in the **common git dir** — the one path every worktree of this
repo resolves to identically, so all of them share it and an unrelated checkout
does not. A second run waits and says who it is waiting for; a lock whose owner
died is cleared rather than waited on. `bun run typecheck:raw` and
`BACKLEX_TYPECHECK_NO_LOCK=1` opt out.

Waiting is strictly cheaper than thrashing: N serial runs cost the sum of their
times, N paging runs cost considerably more, and may cost forever.

It also keeps `--checkers 2` honest. That number is tuned for a machine with
this project's ~9.8 GB peak footprint to itself, and the standing advice to drop
it to `1` exists for exactly the contention this lock now prevents.

**Do not lock at the workspace level.** The root holds the lock while it spawns
each workspace's own `typecheck`, so a second acquire in a child would wait on a
lock its own parent owns, forever.

##### What "slow" actually means here, measured back to back

Same machine, same tree, nothing else running:

| | wall | user | sys |
|---|---|---|---|
| cold (a dependency moved) | 363s | 179s | **494s** |
| warm (nothing changed) | **6s** | 25s | 3.9s |

Two things to take from it. The warm number is the steady state — if a routine
typecheck takes minutes, something invalidated the incremental state, and on
this repo that is almost always a `bun install` or a branch switch, not a code
change. And in the cold row `sys` is 2.75x `user`: three quarters of that run
was paging, which is the same story every measurement on this page tells and the
reason the lock above is worth more than any compiler flag.

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
constraint that makes the TypeScript 7 port look slower than 6.0 below until its
checker count is pinned.

#### TypeScript 7 (the Go port) — adopted 2026-08-19

Every workspace that can run it now declares `typescript` `7.0.2`; the
`typescript-7` alias and the `typecheck:native` script it fed are gone, because
the aliased compiler is the only compiler. The measurement that preceded the
move (2026-08-15, both compilers reporting **identical diagnostics** on this
tree) read like this, and the last row is why it took four days and a wrong
conclusion to get here:

| Project | tsc 6.0 | TS 7.0.2 native | |
|---|---|---|---|
| `packages/core` | 0.49s | 0.25s | 2× faster |
| `apps/web` client | 9.15s | 1.61s | **5.7× faster** |
| `apps/web` server | 152s | 268s | **1.8× slower** |

That last row was **not** a property of the compiler. It was the default
`--checkers` value, and finding that is the single most useful thing in this
section.

##### `--checkers` is the new heap cap — `apps/web`'s server pass needs it

7.0 splits checking across parallel checker instances, and **each instance
carries its own type tables**. On this 8-core box the default fans out far
enough that the server project's footprint reaches 11 GB, which on an 8 GB
machine means it stops compiling and starts paging: three separate runs were
killed at 31, 46 and 10 minutes without ever finishing. That is what the "1.8×
slower" row above was actually measuring.

Pinning the checker count fixes it outright. Same project, same tree, machine
otherwise idle, cold (no `.tsbuildinfo`):

| | wall | user | sys | max RSS | peak footprint | |
|---|---|---|---|---|---|---|
| 7.0 default | — | — | — | — | 11 GB | **never finished** (killed at 10m) |
| 7.0 `--checkers 2` | 422.51s | 152.33s | 456.25s | 2.53 GB | 9.76 GB | ok |
| 7.0 `--checkers 1` | 579.90s | 116.60s | 365.84s | 2.18 GB | 6.55 GB | ok |
| 6.0 (for reference) | 338.56s | 134.19s | 319.18s | 2.28 GB | — | ok |

Read `user`, not `real` — see the methodology note above. At `--checkers 1` the
port does **less** actual CPU work than 6.0 did (116.6s against 134.2s) in
**less** memory (2.18 GB against 2.28 GB); the wall-clock gap is this box
paging, which is the same story every other measurement on this page tells.
`--checkers 2` trades ~36s more `user` and a 3.2 GB larger footprint for 157s
off the wall clock, and that is the one the script ships:

    tsc --noEmit -p tsconfig.server.json --checkers 2

With the flag in place the gate command itself lands where it did before the
move: `bun run typecheck` over the whole repo is **9m45s cold** (no
`.tsbuildinfo` anywhere, every workspace in parallel including both `astro
check` passes) and **19.2s warm** — against 17s warm under 6.0. Day to day this
change is invisible; it only ever showed up cold, and only on this one project.

Drop it to `1` if you are running something else alongside — that is the
low-memory setting, not a slower one. **Do not remove the flag**; the default is
not a smaller number, it is "as many as the machine looks like it can take",
and this project's per-checker working set makes that arithmetic wrong. No
other project in the repo needs it: they are small enough that the fan-out
costs nothing.

There is no `GOMEMLIMIT` escape hatch, and it is worth knowing why so nobody
spends an evening on it. It was tried at 4 GiB. Go's memory limit is a *soft*
target — when the live heap genuinely exceeds it the GC simply runs harder and
the process keeps growing, so the run climbed past 8.6 GB anyway and had to be
killed at 31 minutes. It is not the analogue of `--max-old-space-size`.
`--checkers` is.


**Three things could not move, and each has a different reason.**

`apps/docs` and `apps/site` stay on `typescript` 5.9.3: they typecheck through
`astro check`, which imports the compiler API, and 7.0 ships none. 7.0's package
`exports` map resolves `.` to a version stub — `lib/version.cjs`, ~360 KB for
the whole tarball — so `require("typescript")` succeeds and the first `ts.…`
call is what fails.

`packages/client` stays on 6.0.3 in its **own** `devDependencies` for exactly
that reason, one layer down: `tsup`'s declaration step runs
`rollup-plugin-dts`, which reaches for `ts.sys.useCaseSensitiveFileNames` and
dies with `Cannot read properties of undefined` under 7.0. Bun nests the 6.0.3
copy inside `packages/client/node_modules`, `tsup` resolves it, and the
published `.d.ts` still builds; the package's own `typecheck` reaches back out
to the root's 7.0 binary as `../../node_modules/.bin/tsc`, so its source is
still held to the same compiler as everything else. `packages/cli` did **not**
need the pin — its `tsup.config.ts` never sets `dts: true`, so no declaration
step runs.

Both pins come off when 7.1 restores the API. Nothing else in the tree needed
work: the seven `examples/*` moved from 5.9.3 straight to 7.0.2 clean, and
`next build` (Next 16.3) is unaffected because `experimental.useTypeScriptCli`
already defaults to `true` — Next shells out to `typescript/bin/tsc` rather
than loading the API, and reports the type pass in ~1.1s.

#### The heap cap was load-bearing — until the compiler stopped being V8

`apps/web`'s typecheck used to run the server pass under
`NODE_OPTIONS=--max-old-space-size=8192`. **That flag is gone as of the 7.0
move** — it is a V8 flag, and the 7.0 checker is a Go binary that has never
read it. It was removed rather than left in place as a lie about what guards
the pass. Keep the measurement below anyway, because it is the evidence for how
big this project's live working set actually is, and that has not changed. On
an 8 GB machine an 8192 cap looked absurd, and lowering it was the obvious
first thing to try. It was tried (2026-08-15, cold, idle):

| cap | result | wall | user | sys | peak RSS |
|---|---|---|---|---|---|
| 8192 | ok | 338.56s | 134.19s | 319.18s | 2.28 GB |
| 4096 | **OOM**, exit 134 | 67.66s | 109.85s | 58.50s | 4.01 GB |
| 2048 | **OOM**, exit 134 | 20.77s | 50.15s | 1.91s | 2.37 GB |

The live heap really does exceed 4 GB — the 4096 run died with peak RSS sitting
exactly on its ceiling. Under 6.0 the flag was not slack to be reclaimed; it was
the only thing keeping the pass alive. **Under 7.0 the equivalent lever is
`--checkers`, not a memory number at all** — see the TypeScript 7 section above.
Losing that flag without replacing it is what made the port look like a
regression on this project.

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

### Worker startup, first pass: 11.3 MB of eager graph → 8.2 MB

Cloudflare rejects a deploy whose script takes too long to start — error 10021,
`Script startup exceeded CPU time limit`. That budget pays for V8 compiling the
**eager** module graph and running every module's top-level code, and this
worker was living on the line: the *same bundle* measured 635 ms, 803 ms and
928 ms across three builds, one of which was rejected outright. A retry passed,
which is what made it dangerous — nothing in the code differed between the
failure and the success, so there was nothing to blame and nothing to fix.

Measured rather than guessed, with `node apps/web/scripts/measure-startup.mjs`
(node, not bun: workerd is V8 and so is node, so compile and top-level-eval
costs transfer; JSC would rank the same graph differently). Its `--profile` flag
splits the number into **compile** — proportional to eager bytes — and
**top-level execution**, which is what a module *does* when loaded. The two have
opposite fixes, and the profile said compile dominated.

Three things were on the startup path that no request needs there:

| moved | ~size | who actually needs it |
|---|---|---|
| the 26-vertical schema-template catalog | 900 KB | the picker, apply, first-user seeding |
| `openapi-static.generated.json` | 900 KB | `GET /api/openapi.json` |
| better-auth + kysely | 1.3 MB | the first request that resolves a session |

All three call sites were already `async`, so each became an `import()` — plus
one split in `packages/auth`, because the hot paths only wanted `hashSecret` and
reaching it through the package index dragged better-auth in behind it. It now
lives at `@backlex/auth/secret-hash`.

**The `import()` alone bought nothing, and that is the part worth remembering.**
`vite.config.ts::workerManualChunks` ends in `return "vendor"`, which pins every
un-listed `node_modules` module into the eager chunk *regardless of how it was
imported* — deferring better-auth moved 19 KiB until a branch was added naming
its packages. A dynamic import is only half the change; the chunking rule is the
other half.

| | before | after |
|---|---|---|
| eager graph | 11,352 KiB | **8,179 KiB** |
| compile + top-level (local V8) | ~330 ms | **~280 ms** |
| a deploy's reported startup | 635-928 ms | expect ~0.85x |

`apps/web/tests/worker-startup-budget.test.ts` holds it: it walks static imports
from the worker entry in **source** (so it runs with nothing built) and fails if
any of the three returns, or if the graph outgrows its recorded budget. Being
source-level it is blind to the chunking half — that is what the script measures.

### Worker startup, second pass: 8.2 MB → 6.1 MB

The first pass ended by saying drizzle-orm, zod and hono accounted for "most of
the remaining 2.7 MB". **That was wrong, and it was wrong because it was
asserted rather than measured.** Splitting the `vendor` chunk by its
`//#region` markers gives the real distribution — those three are 874 KiB of
2,714, under a third:

| | KiB | | | KiB |
|---|---:|---|---|---:|
| zod | 528 | | jose | 92 |
| drizzle-orm | 273 | | asn1js | 87 |
| **luxon** | 227 | | `@whatwg-node/node-fetch` | 85 |
| `@ai-sdk/openai` | 205 | | hono | 73 |
| `@ai-sdk/google` | 181 | | `@fastify/busboy` | 43 |
| `@ai-sdk/anthropic` | 157 | | lru-cache | 37 |
| `@ai-sdk/provider-utils` | 115 | | cron-parser | 33 |
| `ai` | 104 | | urlpattern-polyfill | 25 |

Two facts fall straight out of that table. The AI SDK is **860 KiB** — the
largest single thing in the worker, bigger than zod. And `luxon` is 227 KiB of
timezone tables for a package **this repo never imports**: it is `cron-parser`'s
dependency.

Cross-referencing against the bare `node_modules` specifiers reachable from
`entries/worker.ts` through static imports says something sharper still. Only
these are actually reached eagerly:

```
@hono/zod-openapi (101 files)   drizzle-orm (184)   hono (33)   zod (13)
@asteasolutions/zod-to-openapi  ai + @ai-sdk/* ← ONLY mcp/ai-client.ts
cron-parser ← ONLY services/scheduler.ts       aws4fetch (2 adapters)
better-auth ← packages/auth/src/secret-hash.ts
```

`jose`, `asn1js`, `@whatwg-node/*`, `@fastify/busboy`, `lru-cache`,
`urlpattern-polyfill`, `pvtsutils`, `tslib`, `@noble/*`, `rou3` — **none of them
is imported by eager source at all.** They are transitive dependencies of
subsystems that already have a lazy branch (samlify, graphql-yoga, the passkey
plugin, libsql) which fell through `return "vendor"` and were pinned eager
anyway. The same class of bug the `@authenio` and libsql comments in
`vite.config.ts` already warn about, three more times.

Five changes, in the order they had to happen:

| | eager KiB | what changed |
|---|---:|---|
| `secret-hash` → `@better-auth/utils/password` | −160 | `better-auth/crypto`'s index re-exports JWT + symmetric crypto on top of the scrypt it wanted, dragging `jose` and `@noble/ciphers`. The leaf is a five-line wrapper over that package; import it directly. |
| the AI SDK | −860 | `mcp/ai-sdk.ts` holds `ai`, the four providers and `modelFor`; `ai-client.ts` keeps its whole public surface and imports none of it. Both generating functions were already `async`. |
| `cron-parser` + `luxon` | −260 | `entries/worker.ts` reaches `services/scheduler.ts` through `import()` from `scheduled()` and the opt-in HTTP cron endpoint. |
| the migration bundles | −338 | `auto-migrate.ts` inlines 259 `.sql` files as text; `@backlex/db`'s index re-exported it, so ~80 modules pulled it. The index now re-exports the **types** only, and `context.ts` loads the runtime inside the `if (!env.D1)` it was already guarded by — on Workers, never. |
| the four chunking leaks | −435 | Branches for the yoga/whatwg graph, asn1js + pvtsutils/pvutils, `@levischuck`, `js-base64`/`promise-limit`, `tslib`. No code change; these were never imported eagerly in the first place. |

The order matters for exactly one of them: `jose` could not be listed in the
chunking rule while `secret-hash.ts` still reached it, because Rollup keeps a
module eager when anything eager imports it — the branch would have been a lie
that read like a fix.

| | first pass | second pass |
|---|---:|---:|
| eager graph | 8,179 KiB | **6,062 KiB** |
| eager chunks | 281 | **26** |
| `vendor` | 2,714 KiB | **1,020 KiB** |
| compile + top-level (local V8) | ~280 ms | **~220 ms** |

The chunk count collapses because 259 of the 281 were the individual migration
`.sql` files. What is left in `vendor` now really is shared: zod (528),
drizzle-orm (276), hono (73), `zod-to-openapi` (56), unenv (36) — every one of
them reached from eager route code, with no seam short of a redesign.

**`zod` is the largest single item left, and replacing it with valibot would not
move it.** Measured: an equivalent six-field schema is 320 KB minified in zod
against 6.6 KB in valibot, and valibot's *entire* API is 86 KB — so the ceiling
is ~440 KiB. But `zod` is a non-optional dependency of `better-auth`, `ai` and
every `@ai-sdk/*` package, and `@modelcontextprotocol/sdk`; it cannot leave the
tree. And `@hono/zod-openapi` re-exports `z` into 101 route files behind 1,095
`.openapi()` registrations, with no valibot equivalent. The migration would add
valibot's bytes on top of zod's, not instead of them.

Two candidates remain, both larger than anything above and both needing their
own pass: **`packages/integrations`** (763 KiB — 51 provider descriptors behind
one eager `PROVIDERS` registry, the same shape as the template catalog) and the
**MCP tool registry** (~370 KiB, consumed at *module scope* by four routes, so
deferring it means a memoized accessor rather than an `import()`).

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

