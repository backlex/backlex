# workeros

Self-hostable Supabase + Directus alternative. **One codebase, four deploy
targets**: Bun (long-running), Cloudflare Workers, Vercel Edge, Netlify Edge.

```
Dynamic schema · Permissions DSL · REST + GraphQL · Realtime · Edge functions
Storage + folders · Webhooks · Flows · Cron · Activity + revisions · Passkey
Admin UI · Typed SDK · CLI · Type generation
```

## Stack

| Layer       | Tech                                                                  |
|-------------|-----------------------------------------------------------------------|
| API         | [Hono](https://hono.dev) (Bun + Workers + Vercel + Netlify edge)      |
| ORM         | [Drizzle](https://orm.drizzle.team) v1 beta — PG + SQLite/D1          |
| Auth        | [better-auth](https://better-auth.com) — email, OAuth, magic-link, OTP, passkey |
| Storage     | local FS (Bun dev) / Cloudflare R2 (Workers) / S3-compatible (any runtime: AWS, R2, B2, MinIO, Spaces, Wasabi) |
| Vectors     | `pgvector` (PG) / Cloudflare Vectorize (Workers)                      |
| Realtime    | SSE in Bun / Durable Objects on Workers                               |
| Sandbox     | Bun worker thread / Cloudflare dispatch namespace / QuickJS-WASM      |
| Image       | `Bun.Image` (Bun) / Cloudflare Image Resizing (Workers) / passthrough |
| GraphQL     | graphql-yoga, schema auto-generated from collections                  |
| Admin UI    | Vite + React + shadcn/ui + Tailwind v4                                |
| Monorepo    | Bun workspaces                                                        |

## Layout

```
apps/
  api/      Hono API + entry.{bun,worker,vercel,netlify}.ts
  admin/    Vite + React + shadcn admin panel
packages/
  core/     Shared types + adapter interfaces
  db/       Drizzle schemas + dynamic-schema applier + permission compiler
  auth/     better-auth wrapper (email + OAuth + plugins + passkey)
  ui/       shadcn radix-luma component library
  client/   Typed SDK (browser + Node)
  cli/      `workeros` CLI (migrate, gen-types)
```

## Quick start

Prereqs: Bun ≥ 1.1.

```bash
bun install
cp apps/api/.env.example apps/api/.env

# Apply migrations to local SQLite (default for dev)
bun run workeros migrate

# Start API (8787) + admin UI (5173); Vite proxies /api → :8787
bun run dev
```

Sign up the first user at `http://localhost:5173/sign-up` — they automatically
get the `admin` role. Subsequent sign-ups get `authenticated`.

## DB selection (auto)

The API picks a database based on bindings/env in this order:

1. `D1` binding (Cloudflare Workers) → D1 SQLite
2. `DATABASE_URL` → Postgres via `postgres-js`
3. otherwise → Bun SQLite at `./.data/workeros.sqlite`

## Deploy targets

| Target           | Database                | Storage                       | Realtime        | Sandbox        |
|------------------|-------------------------|-------------------------------|-----------------|----------------|
| Bun (self-host)  | SQLite or Postgres      | local fs / S3 (`Bun.S3Client`)| in-proc + SSE   | Worker thread  |
| Cloudflare Workers | D1 or Hyperdrive→PG  | R2 / S3 (`aws4fetch`)         | Durable Objects | QuickJS / dispatch |
| Vercel Edge      | Postgres (Neon HTTP)    | S3 (`aws4fetch`)              | SSE             | QuickJS        |
| Netlify Edge     | Postgres (Neon HTTP)    | S3 (`aws4fetch`)              | SSE             | QuickJS        |

Set `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (and
optionally `S3_ENDPOINT` for non-AWS) and the storage adapter picks the
S3 path automatically. See [Storage on edge](docs/deployment.md#storage-on-edge).

### Bun (self-host)

```bash
APP_URL=https://your.app DATABASE_URL=postgres://... \
  AUTH_SECRET=$(openssl rand -hex 32) \
  bun run --cwd apps/api dev
```

### Cloudflare Workers

```bash
cd apps/api
wrangler d1 create workeros          # paste id into wrangler.toml
wrangler r2 bucket create workeros-files
wrangler vectorize create workeros-embeddings --dimensions=1536 --metric=cosine
wrangler secret put AUTH_SECRET
wrangler d1 migrations apply workeros --remote
wrangler deploy
```

Optional: deploy the function executor sub-Worker for cf-dispatch sandbox:

```bash
wrangler dispatch-namespace create workeros-functions
cd apps/api/templates/fn-executor && wrangler deploy
# then uncomment [[dispatch_namespaces]] in apps/api/wrangler.toml
```

### Vercel

`vercel.json` at the repo root deploys both admin (static) and API (edge).

```bash
vercel link
vercel env add DATABASE_URL    # Postgres URL (Neon recommended for edge)
vercel env add AUTH_SECRET
vercel deploy --prod
```

Cron triggers (`* * * * *` in `vercel.json`) hit `/api/_cron/tick` and call
the same `cronTick` the Bun scheduler uses.

### Netlify

`netlify.toml` at the repo root mirrors the Vercel layout — admin SPA +
edge function for `/api/*` + scheduled function for cron.

```bash
netlify init
netlify env:set DATABASE_URL postgres://...
netlify env:set AUTH_SECRET $(openssl rand -hex 32)
netlify deploy --prod
```

## API surface

```
GET    /health
*      /api/auth/**             better-auth (email, OAuth, magic-link, OTP, passkey)
GET    /api/api-keys            list
POST   /api/api-keys            create — secret returned once
DELETE /api/api-keys/:id        revoke
GET    /api/collections         list
POST   /api/collections         creates physical c_<slug> table
PATCH  /api/collections/:slug   ALTER TABLE for new fields
DELETE /api/collections/:slug   DROP TABLE
GET    /api/items/:slug         filter / sort / fields / limit / offset / meta=count
GET    /api/items/:slug/:id
POST   /api/items/:slug
PATCH  /api/items/:slug/:id
DELETE /api/items/:slug/:id
GET    /api/storage             list (permission-filtered)
PUT    /api/storage/:key        upload (raw body, ?folderId=)
GET    /api/storage/:key        download (?width &height &format &fit &quality for image transforms)
DELETE /api/storage/:key
GET    /api/folders             list
POST   /api/folders             create
GET    /api/activity            list activity entries
GET    /api/revisions/:collection/:itemId
POST   /api/revisions/:id/revert
GET    /api/realtime/items:<slug>/subscribe   permission-filtered change feed
GET    /api/realtime/collections/subscribe    admin-only schema events
*      /api/realtime/:channel/{subscribe,publish}   free-form (no filter)
GET    /api/webhooks            admin
POST   /api/webhooks            admin
GET    /api/flows               admin
POST   /api/flows               admin
GET    /api/functions           admin
POST   /api/functions           admin
POST   /api/functions/:name/invoke
GET    /api/roles               admin
POST   /api/roles               admin
GET    /api/permissions
DELETE /api/permissions/:id     admin
GET    /api/users               admin
POST   /api/users/:id/roles     admin
*      /api/graphql             GraphQL (queries + mutations)
GET    /api/_cron/tick          internal — used by Vercel/Netlify cron
POST   /api/_internal/sandbox-rpc   internal — Bearer-auth, used by cf-dispatch executor
```

## Documentation

- [Getting started](docs/getting-started.md) — first user, first collection, first item
- [Deployment](docs/deployment.md) — Bun / Workers / Vercel / Netlify side by side
- [Permissions DSL](docs/permissions.md) — operators, variables, examples
- [Functions / sandbox](docs/functions.md) — three providers, RPC bridge, security
- [SDK + CLI](docs/sdk-and-cli.md) — `@workeros/client` + `workeros` commands
- [GraphQL](docs/graphql.md) — auto-schema, relations, mutations
- [Realtime](docs/realtime.md) — channels, permission filtering, hosting
- [Adapter pattern](docs/architecture.md) — runtime-agnostic interfaces
- [Design system](docs/DESIGN.md) — admin tokens, layout principles, component contracts, voice

## Adapter pattern

Cross-runtime concerns live behind interfaces in `@workeros/core/adapters`:

- `StorageAdapter` — `fsStorage` (Bun dev) / `r2Storage` (Workers) / `bunS3Storage` (Bun + S3) / `s3FetchStorage` (any runtime + S3)
- `VectorAdapter` — `pgvectorAdapter` (PG) / `vectorizeAdapter` (Workers)
- `RealtimeAdapter` — in-proc + SSE (Bun) / Durable Object + WS (Workers)
- `EmailAdapter` — `consoleEmail` (dev) / `resendEmail` (Resend HTTP)
- `ImageAdapter` — `bunImage` (`Bun.Image`) / `cfImage` (CF Image Resize) / `passthroughImage`

`apps/api/src/context.ts` picks the right adapter based on bindings/env.

## License

MIT
