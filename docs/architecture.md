---
title: Architecture
description: The big picture of workeros in one page — repo shape, runtimes, and adapter layers.
---

The big picture in one page.

## Repo shape

```
workeros/
├─ apps/
│  └─ web/                 One workspace — Hono API + Vite + React admin SPA
│                          (server/ + client/ + entries/{bun,worker,vercel,netlify}.ts)
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
| Realtime            | in-proc + SSE      | DO (Hibernation API) → SSE bridge | in-proc + SSE |
| `EmailAdapter`      | `console`/`resend`/`sendgrid`/`mailgun`/`ses`/`smtp` | same minus `smtp` (no raw TCP) | `console`/`resend`/`sendgrid`/`mailgun`/`ses`/`smtp` |
| `ImageAdapter`      | `bunImage`         | `cfImage`               | `passthroughImage`    |
| `SamlAdapter`       | `samlify`          | `samlify` (via `nodejs_compat`) | `samlify`         |
| `LdapAdapter`       | `ldapts`           | — (no raw TCP; aliased to a throwing shim) | `ldapts`     |

## Hybrid schema ownership

System tables (`users`, `sessions`, `roles`, `permissions`, `files`,
`activity`, `revisions`, `webhooks`, `flows`, `functions`, plus auth /
SSO tables: `app_sessions`, `app_users`, `app_verifications`,
`saml_providers`, `ldap_configs`, `external_identities`, `email_config`,
`auth_config`, `api_keys`, `i18n_strings`, `tenants`, `app_settings`,
`item_ownership`) live in `packages/db/src/{pg,sqlite}/schema.ts` —
Drizzle owns them, and they migrate via hand-written SQL under
`packages/db/drizzle/{pg,sqlite}/`.

User collections live in **physical tables** whose name is whatever the
collection metadata row's `physical_table` column says — the default
the unified create endpoint picks is `c_<tenantPrefix12>_<slug>`, but
adopted collections can wrap any existing table name. `POST /api/collections`
is the single create endpoint and runs DDL only on managed collections
(`adopted: false`); `adopted: true` writes the metadata row alone.
`PATCH/DELETE /api/collections/:slug` apply the same managed-vs-adopted
split.

`applyCollection` is **additive only** — it never drops or alters
existing columns and short-circuits on adopted collections. Field
removal goes through the explicit `dropField` function so admins can
audit destructive moves.

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

## Activity log

The `activity` table is the single audit/log store — there is no
separate logging pipeline. Route handlers call `recordActivity` /
`logActivity` (`services/activity.ts`); actions are dot-namespaced
(`item.create`, `auth.login`, `request.error`). `GET /api/activity`
reads it back: admins see every row, non-admins only their own.

Query params (all optional, AND-combined with the non-admin scope):

- `action` — namespace prefix, matched as `action LIKE '<prefix>%'`
  (`action=item` catches `item.create`, `item.update`, …).
- `from` / `to` — epoch-ms bounds on `created_at` (a dialect-agnostic
  `Date` column, so the window is server-enforced on both PG and
  SQLite).
- `collection`, `itemId` — exact-match filters.
- `limit` (≤ 200) / `offset` — pagination.
- `meta=count` — adds `meta.count`, the total matching the same filters
  (ignores `limit`/`offset`), via one extra `SELECT COUNT(*)`.

The admin surface is the single **Logs** page (`pages/logs.tsx`), which
toggles between a **Stream** lens (HTTP / data / automation / functions
/ storage projection) and a **Table** audit trail. Both views read the
same rows through a paginated `useInfiniteQuery`, pushing the time range
(`from`) and the category chip (`action`) to the server so the view is
never clipped to the freshest 200 rows. (The former standalone
"Activity log" page was merged into this; `/activity` redirects to
`/logs`.)

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
  pg/         PG migrations (hand-written SQL)
  sqlite/     SQLite migrations (hand-written SQL)
```

Migrations in this repo are **hand-written SQL** — `db:generate:*` is
only used to refresh the drizzle snapshot. Both dialects must be edited
in lockstep. After schema changes:

```bash
bun run db:generate:pg         # refresh snapshot only (interactive TTY)
bun run db:generate:sqlite
bun run db:migrate:pg          # needs DATABASE_URL; also CREATE EXTENSION vector
bun run db:migrate:sqlite      # writes to ./.data/workeros.sqlite
bun run db:migrate:d1          # apply sqlite migrations to a local D1
bun run db:migrate:d1:remote   # same, but to deployed CF D1
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
