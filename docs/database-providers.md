---
title: Database providers (Postgres)
description: Provider matrix for the Postgres dialect — self-host, Supabase, Neon, Xata, Vercel PG, Hyperdrive.
---

# Database providers

backlex runs on two SQL dialects — Postgres (`pg`) and SQLite — and within
each dialect it accepts several wire-compatible providers. Picking a
provider is mostly an env-var change; the schema, migrations, permission
compiler, and queries are the same for every entry in a column.

This page documents the **Postgres** column. For the SQLite column see
[sqlite-providers.md](./sqlite-providers.md) (Bun SQLite, Cloudflare D1,
Turso/libSQL, LiteFS).

## Selection rule (one line)

`buildContext` picks the database in this order, first match wins:

1. `env.D1` binding (Cloudflare Workers) → SQLite via D1
2. `env.HYPERDRIVE` binding (Cloudflare Workers) → Postgres via Hyperdrive
3. `env.DATABASE_URL` → Postgres
4. otherwise → SQLite via `bun:sqlite` at `./.data/backlex.sqlite`

The Postgres driver is chosen with `DATABASE_DRIVER`:

- `postgres-js` (default) — `postgres` over `node:net` / `node:tls`. Works
  on Bun, Node, CF Workers (under `nodejs_compat`), Netlify Edge. **Sets
  `prepare: false`** so Supabase's transaction pooler / PgBouncer work
  without `prepare_statement` errors.
- `neon-http` — `@neondatabase/serverless` over `fetch()`. The only
  driver that works on Vercel Edge. Picked automatically on stateless
  edge runtimes if you don't set `DATABASE_DRIVER` explicitly.

## Postgres provider matrix

| Provider          | DATABASE_URL example                                                       | Driver           | pgvector | FTS (tsvector) | JSONB | Notes |
|-------------------|----------------------------------------------------------------------------|------------------|----------|----------------|-------|-------|
| **Self-hosted PG**| `postgres://user:pass@host:5432/backlex`                                  | postgres-js      | ✅ (CREATE EXTENSION vector) | ✅ | ✅ | Reference setup. |
| **Supabase**      | `postgres://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:6543/postgres` | postgres-js | ✅ (toggle in Dashboard → Extensions) | ✅ | ✅ | Use **transaction pooler** (6543), not session pooler. |
| **Neon**          | `postgres://<user>:<pwd>@ep-<id>-pooler.<region>.aws.neon.tech/<db>?sslmode=require` | postgres-js (Bun/CF/Node) / neon-http (Vercel Edge) | ✅ (CREATE EXTENSION vector) | ✅ | ✅ | Auto-suspend wakes on first query; first request after idle ≈ 100–500 ms. |
| **Xata**          | `postgres://<workspace-id>:<api-key>@<workspace>.<region>.xata.sh:5432/<db>:<branch>?sslmode=require` | postgres-js | ❌ — pair with Vectorize or another PG | ✅ | ✅ | Branch lives in the URL after the database name (`<db>:<branch>`). |
| **Vercel Postgres** | (issued by `vercel env`)                                                 | neon-http        | ✅ | ✅ | ✅ | Re-branded Neon under the hood; identical config. |
| **Hyperdrive (CF)** | (binding, not URL)                                                       | postgres-js      | depends on origin | depends on origin | ✅ | Caches connections + idle queries; origin can be any of the rows above. |

## Per-provider gotchas

### Supabase

- The **transaction pooler** on port `6543` is the right URL — it terminates
  prepared statements before they hit Postgres, which is why backlex sets
  `prepare: false` on the postgres-js driver. Using the **session pooler**
  (`5432`) also works, but you lose the pooler's protection against connection
  exhaustion on serverless invocations.
- Enable pgvector once per project: **Database → Extensions → `vector` → Enable**.
- Supabase Realtime is *not* used. backlex has its own realtime layer
  (`docs/realtime.md`) over SSE / Durable Objects, which respects the
  permission DSL — Supabase Realtime ignores it.

### Neon

- Default = `postgres-js`. Switch to `DATABASE_DRIVER=neon-http` only when
  the runtime can't open `node:net` (Vercel Edge) — `neon-http` has higher
  per-query latency (one HTTP round-trip per statement, no pipelining).
- Enable pgvector once: `CREATE EXTENSION IF NOT EXISTS vector;`.
- Read replicas: set `DATABASE_REPLICA_URL` to the replica endpoint; the
  driver and pgvector requirement match the primary.
- The **scale-to-zero** behaviour means the first request after several
  minutes of idle waits for the compute to wake. Auto-migrate at boot
  amortises this on cold start; subsequent requests are normal.

### Xata

- Xata speaks standard Postgres — the `postgres-js` driver works out of
  the box with the connection string from the Xata dashboard.
- **No pgvector.** backlex detects `.xata.sh` URLs and routes vector
  endpoints to `noVectorAdapter` unless a Cloudflare Vectorize binding
  is present (`VECTORIZE_OPENAI` / `VECTORIZE_OPENAI_LARGE` /
  `VECTORIZE_BGE_M3` / `VECTORIZE_SELF_HOST_BGE_M3`). Two combinations
  that work:
  - **Xata + Cloudflare Workers** → bind a Vectorize index, vector
    endpoints route there automatically.
  - **Xata for relational + another PG for vector** → not supported in a
    single deploy (backlex uses one DB). Use Vectorize.
- The URL embeds the branch name *after* the database with a colon:
  `…/<db>:<branch>`. backlex doesn't manage Xata branches; the branch is
  fixed at deploy time via the URL.
- Workspace-level full-text search via Xata's `/search` endpoint is also
  not used — backlex uses Postgres `tsvector` + `websearch_to_tsquery`
  on the underlying table, which goes through the standard wire protocol.

### Hyperdrive (CF Workers only)

- `HYPERDRIVE` binding's `connectionString` always wins over `DATABASE_URL`.
- Hyperdrive is a connection pooler + query cache that sits in front of
  your real Postgres (any provider above). It speaks the Postgres wire
  protocol, so the driver is still `postgres-js`.
- pgvector support depends on the *origin* database, not Hyperdrive itself.

## Auto-migrate compatibility

Boot-time auto-migrate (`packages/db/src/auto-migrate.ts`) runs the bundled
SQL migrations on first request. It is **idempotent** — running it against
a database that already has the schema is a no-op — and **failure-tolerant**:
a single bad statement is logged and skipped, the rest of the boot continues.

This matters most for managed providers where you can't run
`bun run db:migrate:pg` yourself between deploys:

- **Supabase / Neon / Vercel PG** — auto-migrate runs on first request after
  the deploy completes. Same code path as self-host.
- **Xata** — same, **except** any migration statement that depends on
  pgvector will be logged-and-skipped; this is intentional.
- **CF Workers + D1** — out of scope: `wrangler d1 migrations apply` runs
  in the Workers Build command before the worker boots.

If you want to run migrations explicitly before the first request, point
`DATABASE_URL` at the target and run `bun run db:migrate:pg` from your
laptop or CI — same SQL, same idempotency.

## Choosing a provider

- **Pure relational + vector + small team** → Supabase. Free tier covers
  development; pgvector is one click; pooler URL just works.
- **Edge-native deploy (Vercel Edge / wide region spread)** → Neon with
  `DATABASE_DRIVER=neon-http`.
- **Already on Cloudflare, want SQLite** → D1 (see sqlite-providers.md).
- **Already on Cloudflare, want Postgres** → Hyperdrive in front of any
  of the above.
- **Branching-first workflow (preview-per-PR DB)** → Neon (branching
  built-in) or Xata (branches are a URL suffix). Xata branches are free
  on the dashboard; Neon branches are charged by storage.

## See also

- `docs/deployment.md` — full deploy steps per runtime
- `docs/architecture.md` — how the dual-dialect schema works
- `docs/sqlite-providers.md` — Bun SQLite, D1, Turso/libSQL, LiteFS
- `apps/web/.dev.vars.example` — copy/paste-ready env blocks
