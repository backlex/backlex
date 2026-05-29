---
title: Database providers (SQLite)
description: Provider matrix for the SQLite dialect — Bun SQLite, Cloudflare D1, Turso / libSQL, and LiteFS.
---

# Database providers (SQLite)

backlex' SQLite dialect ships against four transports — local Bun, D1,
libSQL/Turso, and LiteFS. The schema, migrations, permission compiler,
and queries are identical across all of them; what changes is *where the
bytes live* and *how the runtime talks to them*.

For the Postgres-side matrix (Supabase / Neon / Xata / self-host) see
[database-providers.md](./database-providers.md).

## Selection rule

`buildContext` picks the SQLite transport in this order, first match wins:

1. `env.D1` binding → Cloudflare D1 (`createD1Client`)
2. `env.LIBSQL_URL` → libSQL / Turso (`createLibsqlClient`)
3. `env.DATABASE_URL` set → falls back to **Postgres**, not SQLite
4. otherwise → Bun SQLite at `env.SQLITE_PATH` (default `./.data/backlex.sqlite`)

Step 3 means a Postgres URL always wins over the Bun-SQLite fallback. Set
`LIBSQL_URL` (with no `DATABASE_URL`) to flip a fresh deploy onto Turso.

## SQLite provider matrix

| Provider          | Transport         | Runtime support                          | Vector | FTS (fts5) | Migrations applied by                                |
|-------------------|-------------------|------------------------------------------|--------|------------|------------------------------------------------------|
| **Bun SQLite**    | local file        | Bun + Node self-host                     | ❌ — pair with Vectorize / pgvector | ✅ | `bun run db:migrate:sqlite` (CLI) |
| **Cloudflare D1** | binding           | CF Workers only                          | ❌ — pair with Vectorize | ✅ | `wrangler d1 migrations apply` inside the Workers Build command |
| **Turso / libSQL**| HTTP / WS / WS-libsql | every runtime (fetch-based)         | ❌ — pair with Vectorize | ✅ | `bun run db:migrate:libsql` (CLI) **or** boot-time auto-migrate |
| **LiteFS (Fly)**  | local file via FUSE | Bun / Node only (no edge)              | ❌ — pair with Vectorize / pgvector | ✅ | Same as Bun SQLite — runs on primary, replicates to read-replicas |

**Vector**: SQLite has no first-class vector type that backlex uses. Vector
endpoints require **either** a Cloudflare Vectorize binding (`VECTORIZE_OPENAI`
/ `VECTORIZE_BGE_M3` / …) **or** switching to a Postgres deploy with
pgvector. Without one, vector endpoints fail loud with a clear message.

## Per-provider gotchas

### Bun SQLite

- Default for `bun run dev`. File path is `./.data/backlex.sqlite`; the
  directory is created on first write.
- `PRAGMA journal_mode = WAL` is set at client construction → concurrent
  readers + a single writer perform well on a single-process deployment.
- Not suitable for multi-process / multi-container deployments — for that
  use D1, Turso, or LiteFS.

### Cloudflare D1

- D1 ships read replicas via the Sessions API. The HTTP layer reads the
  `x-d1-bookmark` request header, pins the session forward, and writes
  the latest bookmark back on the response so the next request follows
  the same replica. This is wired in by `createD1SessionClient`; routes
  don't need to know it's happening.
- Migrations are applied by the **Workers Build command**
  (`bun run db:migrate:d1:remote && bun run build`), not by the runtime
  auto-migrate path. This keeps cold-start times tight on CF Workers.
- Multi-statement HTTP calls aren't pipelined the way `postgres-js`
  pipelines them — the auto-migrate splitter (`-->statement-breakpoint`)
  is what keeps each statement individually addressable.

### Turso / libSQL

- Connection string scheme picks the transport:
  - `libsql://…` — Turso's negotiated WS/HTTPS (recommended)
  - `wss://…` / `ws://…` — Hrana WebSocket directly
  - `https://…` / `http://…` — Hrana HTTP (one round-trip per statement)
  - `file:…` — local libSQL file (rare; prefer Bun SQLite)
- `LIBSQL_AUTH_TOKEN` is required for any Turso URL; optional for
  self-hosted `sqld` with auth disabled.
- The libSQL client is pure JS + fetch — works on every runtime backlex
  supports including Vercel Edge and Netlify Edge (whereas Bun SQLite
  needs `bun:sqlite`, which those edges don't have).
- Boot-time auto-migrate runs on first request, same as Postgres. To run
  migrations explicitly (e.g. from CI before the first request):

  ```bash
  LIBSQL_URL=libsql://my-db-org.turso.io \
  LIBSQL_AUTH_TOKEN=eyJ... \
    bun run --cwd packages/db migrate:libsql
  ```
- Embedded replicas (`@libsql/client` `syncUrl`) are out of scope for
  backlex — open a custom client outside the standard adapter if you
  need them.

### LiteFS (Fly.io)

- Backlex doesn't talk to LiteFS directly. Point `SQLITE_PATH` at the
  LiteFS-mounted file (e.g. `/litefs/backlex.sqlite`); the Bun SQLite
  driver opens it the same way it opens any local file.
- **Writes only on the primary node.** LiteFS replicates one-way from
  the primary to read-replicas. On Fly, set `primary_region` in
  `fly.toml` and use [`fly-replay`](https://fly.io/docs/networking/dynamic-request-routing/)
  to forward write requests:

  ```toml
  # fly.toml
  [[services.http_checks]]
    # …backlex checks…

  [services]
    # Forward writes (POST/PUT/PATCH/DELETE) to the primary
    [[services.http_response_headers]]
      x-fly-replay = "region={{ env.PRIMARY_REGION }}"
  ```

  This sits outside backlex; the app itself doesn't need a
  primary/replica concept.
- LiteFS isn't an edge transport — it needs FUSE, so it only runs on
  Bun / Node containers (Fly Machines, Railway, a VPS).
- `PRAGMA journal_mode` on LiteFS-mounted files is fixed to a
  LiteFS-compatible mode by the FUSE layer; the `journal_mode = WAL`
  backlex tries to set may no-op silently — that's expected.

## Auto-migrate compatibility

`auto-migrate.ts` runs the bundled SQL migrations on first request on every
SQLite transport **except** D1 (D1 has its own CLI-driven path that fires
during the Workers Build):

| Provider          | Auto-migrate on first request? |
|-------------------|--------------------------------|
| Bun SQLite        | ✅                              |
| Turso / libSQL    | ✅                              |
| LiteFS (primary)  | ✅                              |
| LiteFS (replica)  | ✅ (no-op — read-only FS)       |
| Cloudflare D1     | ❌ — `wrangler d1 migrations apply` instead |

The runner is idempotent. A statement that fails (already-applied SQL,
unsupported pragma) is logged and skipped, the rest of the boot
continues. See `packages/db/src/auto-migrate.ts` for the contract.

## Choosing a transport

- **Local dev / single-machine deploy** → Bun SQLite. Zero config.
- **Cloudflare Workers** → D1. First-class binding, region-aware
  replicas, no separate connection string to manage.
- **Multi-region edge (Vercel/Netlify Edge or Workers across providers)
  + want SQLite semantics** → Turso. The fetch-based driver works on
  every runtime, including the V8-isolate edges that block `bun:sqlite`.
- **Multi-node single-region deploy with low-latency local reads** →
  LiteFS. Best when you already run on Fly.io and need write-locality
  to one region with replicated reads everywhere else.

## See also

- `docs/database-providers.md` — Postgres-side matrix (Supabase, Neon, Xata, …)
- `docs/deployment.md` — full deploy steps per runtime
- `docs/architecture.md` — how the dual-dialect schema works
- `apps/web/.dev.vars.example` — copy/paste-ready env blocks
