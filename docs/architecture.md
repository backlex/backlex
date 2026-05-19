# Architecture

The big picture in one page.

## Repo shape

```
workeros/
├─ apps/
│  ├─ api/                 Hono app, four entries (bun, worker, vercel, netlify)
│  └─ admin/               Vite + React + shadcn admin panel
└─ packages/
   ├─ core/                Types only (DSL, errors, adapter interfaces)
   ├─ db/                  Drizzle schemas (pg + sqlite) + dynamic-DDL applier + DSL compiler
   ├─ auth/                better-auth wrapper + plugin selection
   ├─ ui/                  shadcn radix-luma component library
   ├─ client/              `@workeros/client` typed SDK
   └─ cli/                 `workeros` CLI
```

## Adapter pattern

Every cross-runtime concern hides behind a TypeScript interface in
`@workeros/core/adapters`. `apps/web/src/server/context.ts::buildContext`
picks the right implementation based on bindings/env.

| Interface           | Bun                | Cloudflare Workers      | Vercel/Netlify Edge   |
|---------------------|--------------------|-------------------------|-----------------------|
| `StorageAdapter`    | `fsStorage` / `bunS3Storage` | `r2Storage` / `s3FetchStorage` | `s3FetchStorage`     |
| `VectorAdapter`     | `pgvectorAdapter`  | `vectorizeAdapter`      | `pgvectorAdapter`     |
| `RealtimeAdapter`   | in-proc + SSE      | DO + WebSocket          | in-proc + SSE         |
| `EmailAdapter`      | console / Resend   | Resend                  | Resend                |
| `ImageAdapter`      | `bunImage`         | `cfImage`               | `passthroughImage`    |

## Hybrid schema ownership

System tables (`users`, `sessions`, `roles`, `permissions`, `files`,
`activity`, `revisions`, `webhooks`, `flows`, `functions`, `passkey`)
live in `packages/db/src/{pg,sqlite}/schema.ts` — Drizzle owns them, and
they migrate via the standard Drizzle pipeline.

User collections (`posts`, `comments`, anything you create from admin
or the API) live in physical tables `c_<slug>` created at request time
by `packages/db/src/schema-applier.ts`. The metadata in `collections`
drives a CREATE/ALTER/DROP cycle whenever a `POST/PATCH/DELETE
/api/collections` lands.

`applyCollection` is **additive only** — it never drops or alters
existing columns. Field removal goes through the explicit `dropField`
function so admins can audit destructive moves.

## Permission DSL

One DSL, three execution paths:

| Path                       | Compiler          | Output                  |
|----------------------------|-------------------|-------------------------|
| REST + GraphQL filter      | `compileCondition` | Drizzle `SQL` fragment, parameterized |
| Realtime per-event filter  | `matchesCondition` | boolean (in-memory)    |
| Sandbox `ctx.db.list/one`  | `compileCondition` (via host bridge) | SQL fragment       |

Same operators, same variables (`$user.id`, etc.), same logical
combinators. A filter that works in one place works in the others.

## Sandbox provider selection

Three providers, one selector:

```
priority 1: remote-http  → env.FUNCTIONS_EXEC_URL set (out-of-isolate executor)
priority 2: bun-worker   → Bun runtime
priority 3: quickjs      → anywhere else (Workers, Vercel, Netlify, Node)
```

The host bridge (`apps/web/src/server/services/sandbox/host-bridge.ts`) is the
single dispatcher for `ctx.fetch / ctx.db / ctx.email`. bun-worker calls
it in-process; remote-http calls it over HTTP at
`/api/_internal/sandbox-rpc` with a Bearer token. Both paths funnel
through the same permission pipeline.

## Event flow

CRUD routes call `publishEvent(env, channel, payload, serverCtx)`:

```
┌─ items.ts route ─┐
│  POST /api/items │
│        │         │
│        ▼         │
│ publishEvent ────┼───► realtime (SSE / DO)            ◄── connected subscribers
│        │         │
│        ├───────► dispatchWebhooks ──► HMAC-signed POST to webhook.url
│        │
│        ├───────► runFlows ──────► op chain (log/webhook/email/condition)
│        │
│        └───────► runEventFunctions ──► matching cron-/event-trigger functions
└──────────────────┘                     in the sandbox provider
```

All four downstream consumers see the same event payload. Webhooks +
flows + functions are fire-and-forget — they don't block the API
response.

## Auth pipeline

Per-request middleware in `apps/web/src/server/app.ts`:

1. **CORS** — origin = `env.APP_URL`, credentials allowed.
2. **buildContext** — wires DB, adapters, schema-seeded roles.
3. **sessionMiddleware** — better-auth cookie first, then `Bearer pak_…`
   API key fallback. Loads role names into `c.var.auth`.
4. Route handler — for resource routes, pairs with `requirePermission`
   middleware that resolves DSL + sets `c.var.permission`.

`first user gets admin`: better-auth's `databaseHooks.user.create.after`
counts users; if it's 1, assign `admin`, else `authenticated`.

## State that's local to a process

In-process state that doesn't survive across multiple workers / regions:

- Realtime subscribers Map (Bun) — single-instance only
- `lastTickAt` for cron dedupe — per-process; safe because `cronTick`
  is idempotent (only fires when `prev() ∈ (lastTickAt, now]`)
- `rolesSeeded` flag — boots once per isolate; the seed function is
  idempotent so multi-isolate is fine

For multi-instance Bun deployments (rare), use Workers or accept that
realtime fan-out is per-instance.

## Migrations

```
packages/db/drizzle/
  pg/         drizzle-kit-generated PG migrations
  sqlite/     drizzle-kit-generated SQLite migrations
```

Both dialects must be edited in lockstep. After schema changes:

```bash
bun run db:generate:pg
bun run db:generate:sqlite
bun run db:migrate:pg          # needs DATABASE_URL
bun run db:migrate:sqlite      # default to ./.data/workeros.sqlite
# or via the CLI:
bun run workeros migrate
```

## Why these tradeoffs

- **Hybrid schema** instead of all-Drizzle: matches the Directus mental
  model where the user's data shape evolves at runtime, but keeps system
  tables under static migration control.
- **Own permission DSL** instead of CASL: needed something the SQL
  compiler could read; CASL is row-evaluation-only and didn't fit.
- **Three sandbox providers** instead of one: free-tier Workers users
  shouldn't lose function execution; paid users shouldn't be stuck on
  WASM-slow QuickJS.
- **passkey-first** in Phase 5.7: phishing-resistant, hardware-backed,
  better UX than TOTP. TOTP plugin still available for compliance use.
