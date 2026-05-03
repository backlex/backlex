# workeros

Bun + Cloudflare Workers backend platform — a self-hostable Supabase / Directus
alternative. Single codebase, two deploy targets:

- **Self-host**: Bun runtime + Postgres (with `pgvector`)
- **Edge**: Cloudflare Workers + D1 (or Hyperdrive→Postgres) + R2 + Vectorize

## Stack

| Layer       | Tech                                                        |
|-------------|-------------------------------------------------------------|
| API         | [Hono](https://hono.dev) (Bun + Workers + Node compatible)  |
| ORM         | [Drizzle](https://orm.drizzle.team) — PG + SQLite/D1        |
| Auth        | [better-auth](https://better-auth.com) (email/password, OAuth-ready) |
| Storage     | local FS (dev) / Cloudflare R2 (edge)                       |
| Vectors     | `pgvector` (PG) / Cloudflare Vectorize (edge)               |
| Realtime    | SSE in Bun, Durable Objects on Workers                      |
| Admin UI    | Vite + React + shadcn/ui + Tailwind v4                      |
| Monorepo    | Bun workspaces                                              |

## Layout

```
apps/
  api/      Hono API (entry.bun.ts + entry.worker.ts)
  admin/    Vite + React + shadcn admin panel
packages/
  core/     Shared types + adapter interfaces (storage/vector/realtime)
  db/       Drizzle schemas (pg + sqlite) and clients
  auth/     better-auth configuration
```

## Quick start (self-host)

Prereqs: Bun ≥ 1.1, Postgres 14+ with `pgvector` (or skip for local SQLite).

```bash
bun install
cp apps/api/.env.example apps/api/.env
cp apps/admin/.env.example apps/admin/.env

# (optional) generate + run Postgres migrations
bun run db:generate
bun run db:migrate

# dev: starts both API (3000) and admin UI (5173) — Vite proxies /api → :3000
bun run dev
```

The API auto-detects its database:

1. `D1` binding (Workers) → SQLite via D1
2. `DATABASE_URL` → Postgres via `postgres-js`
3. otherwise → Bun SQLite at `./.data/workeros.sqlite`

## Edge deploy (Cloudflare Workers)

```bash
cd apps/api

# create resources
wrangler d1 create workeros            # paste id into wrangler.toml
wrangler r2 bucket create workeros-files
wrangler vectorize create workeros-embeddings --dimensions=1536 --metric=cosine

# secrets
wrangler secret put AUTH_SECRET

# apply schema to D1
wrangler d1 migrations apply workeros --remote

wrangler deploy
```

The admin UI builds to a static SPA — host it on Cloudflare Pages, R2 + a
Worker, or any static host. Set `VITE_API_URL` to your Worker URL at build
time.

## API surface

```
GET    /health
*      /api/auth/**            # better-auth
GET    /api/collections
POST   /api/collections        # auth required
GET    /api/collections/:slug
PATCH  /api/collections/:slug  # auth required
DELETE /api/collections/:slug  # auth required
GET    /api/records/:slug
GET    /api/records/:slug/:id
POST   /api/records/:slug      # auth required
PATCH  /api/records/:slug/:id  # auth required
DELETE /api/records/:slug/:id  # auth required
GET    /api/storage?prefix=…
PUT    /api/storage/:key       # auth required, raw body
GET    /api/storage/:key
DELETE /api/storage/:key       # auth required
POST   /api/vector/upsert      # auth required
POST   /api/vector/query
POST   /api/vector/delete      # auth required
GET    /api/realtime/:channel/subscribe   # SSE (Bun) / WS (Worker)
POST   /api/realtime/:channel/publish
```

## Adapter pattern

Cross-runtime concerns live behind interfaces in `@workeros/core/adapters`:

- `StorageAdapter` → `fsStorage` (Bun) / `r2Storage` (Worker)
- `VectorAdapter` → `pgvectorAdapter` (PG) / `vectorizeAdapter` (Worker)
- `RealtimeAdapter` → in-process pub/sub + SSE (Bun) / Durable Object + WS (Worker)

`apps/api/src/context.ts` wires the right adapter based on the available
bindings/env.

## License

MIT
