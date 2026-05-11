# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the repo root via Bun workspaces.

```bash
bun install
bun run dev                # Vite + Cloudflare miniflare in one process (port 5173)
bun run dev:bun            # Bun-native API only on :8787 (no admin SPA)
bun run typecheck          # all workspaces
bun run build              # vite build (admin SPA + worker bundle)
bun run deploy             # vite build + wrangler deploy (CF)

# DB — pick the dialect explicitly; there is no shared command:
bun run db:generate:pg     # drizzle-kit generate against packages/db/src/pg/schema.ts
                           # ⚠ requires an interactive TTY (drizzle-kit asks
                           # 'did you mean rename' for any column-pair that
                           # looks similar). Run from your own terminal —
                           # CI/sandbox shells without a TTY will fail with
                           # 'Interactive prompts require a TTY terminal'.
bun run db:generate:sqlite
bun run db:migrate:pg      # needs DATABASE_URL; also CREATE EXTENSION vector
bun run db:migrate:sqlite  # writes to ./.data/workeros.sqlite (Bun SQLite)
bun run db:migrate:d1      # apply drizzle/sqlite migrations to a local D1
bun run db:migrate:d1:remote # same, but to the deployed CF D1 (--remote)
```

There is no test runner configured yet.

## Local test admin

For smoke tests / Claude debug runs against the local dev server (`bun run dev` on http://localhost:5173):

- **Email:** `admin@example.com`
- **Password:** `correct-horse-battery`

Mirrored in `apps/web/.dev.vars.example` (`TEST_ADMIN_EMAIL` / `TEST_ADMIN_PASSWORD`). Sign in via `POST /api/auth/sign-in/email` (always send `Origin: http://localhost:5173` — better-auth rejects requests without it). If the local D1/SQLite is fresh and this account isn't the first user, sign it up via `POST /api/auth/sign-up/email`, then grant the admin role manually:

```sql
INSERT INTO user_roles (user_id, role_id, created_at)
VALUES ('<user-id>', (SELECT id FROM roles WHERE name='admin'), strftime('%s','now')*1000);
```

(`user_roles` has a composite PK on `(user_id, role_id)` — there's no `id` column.)

## Workflow: branch → merge → auto-deploy

Every working session runs on its own branch. Merging into `main` triggers `.github/workflows/deploy.yml`, which runs `bun run build` and `wrangler deploy` against the `workeros-api` Worker. Required GitHub secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

**Always create a new branch BEFORE doing any work.** This is mandatory — do not edit files, run commands that mutate state, or otherwise begin a task while still checked out on `main` (or any other unrelated branch). The very first step of every new task is:

```bash
git checkout main && git pull origin main
git checkout -b feat/<short-topic>
```

Only after the new branch exists may you proceed with edits, commits, etc. If you find yourself on `main` with uncommitted changes when a task begins, stop and create the branch first (a `git stash` + branch + `git stash pop` is fine).

**Branch naming:** `feat/<short-topic>` (e.g. `feat/admin-functions-page`).

**When the user says "publish"** (or "yayınla" / "deploy et"), follow these steps in order — do not skip or reorder:

```bash
# 1. Make sure the working tree is clean and the topic branch is committed
git status

# 2. Switch to main and pull the latest
git checkout main
git pull origin main

# 3. Direct-merge the feature branch (no PR)
git merge <feat/branch-name>

# 4. Push — this triggers the Cloudflare deploy workflow
git push origin main

# 5. Confirm the workflow started
gh run list --workflow deploy.yml --limit 1
```

After pushing, report the workflow run URL back to the user. Don't claim "deployed" until the run is green — `gh run watch` or `gh run view <id>` confirms.

**After the deploy run goes green**, smoke-test the change against the live URL with the puppeteer MCP server (`mcp__puppeteer__puppeteer_*` tools). The default target is the production deploy unless the user names a specific URL. Drive the relevant flow end-to-end (sign in, exercise the feature touched by this branch, watch for console/network errors via `puppeteer_evaluate`) and screenshot the result. Report what you tested and what you saw — don't call it shipped without that pass.

## Architecture

### One app, four runtimes

`apps/web` is a single workspace that ships **both** the Hono API and the React admin SPA. The Vite config uses `@cloudflare/vite-plugin` so a single `bun run dev` spins up the SPA with HMR AND the Worker via miniflare on port 5173. `bun run build` emits `apps/web/dist/client` (SPA) + `apps/web/dist/workeros_api` (Worker bundle); `wrangler deploy` ships both as one Worker (Static Assets binding for the SPA).

Layout under `apps/web/src/`:

- `client/` — Vite + React + Tailwind v4 admin (`@/` alias points here). Entry `client/main.tsx`.
- `server/` — Hono app + adapters + routes + services. Four entries in `server/entries/`:
  - `bun.ts` — `Bun.serve` for self-host
  - `worker.ts` — `default { fetch, scheduled }` + `export RealtimeRoom`
  - `vercel.ts` — `hono/vercel` adapter
  - `netlify.ts` — `hono/netlify` adapter
- `server/app.ts` — `createApp(env)` builds the Hono app, mounts middleware + routes.
- `server/env.ts` — runtime-agnostic `Env` interface; Cloudflare binding fields (`D1`, `R2`, `VECTORIZE`, `REALTIME`, `HYPERDRIVE`) are optional and only present on Workers.

The admin's API client (`client/lib/api.ts`) defaults to relative `/api/...` paths, so same-origin deploys (CF Workers + Static Assets) work without `VITE_API_URL`. Set `VITE_API_URL` only for cross-origin setups.

Anything runtime-specific must stay behind the adapter layer — do not branch on `typeof process` etc. inside route code.

### Context + adapter wiring

`src/context.ts::buildContext(env)` is the single place that decides the runtime profile. It returns a `Ctx` (db, auth, storage, vector, dialect) attached to every request as `c.get("ctx")`. The auth state lives in `c.get("auth")` (set by `middleware/session.ts`).

Selection rules — keep these consistent if you add a new adapter:

| Concern   | Rule                                                                  |
|-----------|-----------------------------------------------------------------------|
| dialect   | `D1` binding → `sqlite`; `DATABASE_URL` → `pg`; else `sqlite`         |
| db        | D1 client / `postgres-js` / Bun SQLite at `./.data/workeros.sqlite`   |
| storage   | `R2` binding → `r2Storage`; else `fsStorage("./.data/files")`         |
| vector    | `VECTORIZE` → `vectorizeAdapter`; pg dialect → `pgvectorAdapter`; else throws |
| realtime  | `REALTIME` (DO) → WS forward; else in-process pub/sub + SSE           |

Adapter contracts live in `packages/core/src/adapters/{storage,vector,realtime}.ts`. Concrete implementations live in `apps/web/src/server/adapters/*` (e.g. `storage.fs.ts` vs `storage.r2.ts`).

### Dual-dialect Drizzle (system tables only)

`packages/db` ships **two parallel schemas** — `src/pg/schema.ts` and `src/sqlite/schema.ts` — exported via subpaths (`@workeros/db/pg`, `@workeros/db/sqlite`, plus `/schema` variants). System tables (`users`, `sessions`, `accounts`, `verifications`, `collections`, `embeddings`, `files`) exist in both; column types differ where the dialects do (`integer` timestamps + JSON-as-text on SQLite, native `timestamp` + `jsonb` on PG; `pgvector` only on PG).

When changing schema, **always edit both files** and regenerate both migration sets (`db:generate:pg` and `db:generate:sqlite`). Drizzle-kit configs live at `packages/db/drizzle.{pg,sqlite}.config.ts`.

`db` is typed as `PgDb | SqliteDb`; route handlers cast to `any` when running shared queries because the union is structurally compatible at the SQL builder level but not in the type system.

### API keys + Email + OAuth (Phase 5)

- **API keys**: `api_keys` table; full key format is `pak_<8-hex prefix>_<32-hex secret>`. Only the SHA-256 of the secret is stored; the plaintext is returned exactly once on POST and never retrievable. `apps/web/src/server/services/api-keys.ts` handles create/list/revoke + lookup. Auth middleware (`middleware/session.ts`) tries the better-auth cookie session first, then falls back to `Authorization: Bearer pak_...`. Resolved key impersonates its `user_id` so the request inherits that user's roles + permissions, and pins the request to the key's `tenant_id`. **`name` is optional** on POST (a timestamped default is generated) and **`expires_at` is optional** (lookup rejects expired keys). **Role scoping**: a key may set `role_id` — when present, the request resolves permissions against *only* that role (no implicit `authenticated`), and only while the owner still holds it (`loadRolesForUser`/`loadTenantRoleNames` both gate on `(user_roles ⋈ roles) WHERE role.id = key.role_id`). So a scoped key can never grant more than its owner currently has. Creation rejects a `role_id` the owner doesn't hold (admins included — grant yourself the role first if you want a narrow self-key). `GET /api/api-keys/available-roles` lists the roles the caller may bind (admins: every workspace role; others: only roles they hold). `auth.apiKeyRoleId` carries the scope through the middleware chain (set in `app.ts` `AppBindings` and `AuthSubject` in `@workeros/core`).
- **EmailAdapter**: interface in `packages/core/src/adapters/email.ts` (`send({to, subject, text, html?, from?})`). Implementations live in `apps/web/src/server/adapters/email.{console,resend}.ts`. `buildContext` picks Resend when `RESEND_API_KEY` + `EMAIL_FROM` are set; otherwise falls back to the console adapter (logs to stdout — fine for dev). Use `ctx.email.send(...)` from any route — never reach for SMTP/Resend SDKs directly.
- **OAuth providers**: `OAUTH_GOOGLE_CLIENT_ID/SECRET` and `OAUTH_GITHUB_CLIENT_ID/SECRET` env vars. If both id+secret are present for a provider, it's wired into better-auth's `socialProviders` automatically. Endpoints follow better-auth conventions (`/api/auth/sign-in/social`, `/api/auth/callback/<provider>`).

When adding a new auth surface, prefer extending the better-auth plugin set (passes through `databaseHooks` so the first-user-becomes-admin logic still applies) over rolling a parallel sign-in flow.

### Realtime (permission-aware change feed)

`apps/web/src/server/services/events.ts` is the publish/subscribe core. Item CRUD routes call `publishEvent(env, "items:<slug>", { event, data })` after a successful write. Subscribers receive only events that pass their permission filter.

- **Channels**: `items:<slug>` (per-collection change feed), `collections` (admin-only schema events), and any other free-form name (legacy user channels with no auth/filter).
- **Subscribe gate** in `apps/web/src/server/routes/realtime.ts::gateForChannel`: for `items:*` resolves `read` permission and bundles `{authSubject, conditions, fields}` as `SubscriptionMeta`. For `collections` requires the `admin` role. For user channels, no gate (back-compat). System channels reject external `POST /:channel/publish`.
- **Filter evaluation** uses `matchesCondition` (in-memory, dialect-free) from `packages/db/src/permission.ts` — same DSL the SQL compiler uses. `lookup` tries snake_case first, then camelCase fallback so it works against both raw rows and deserialized API payloads.
- **Per-subscriber projection**: if the role's `fields` allow-list is set, the event payload is filtered to that list (system fields `id, createdAt, updatedAt, ownerId` are always kept).
- **Bun**: `subscribeLocal`/`publishLocal` keep a module-level `Map<channel, Set<Subscriber>>`. SSE handler uses a queue + wakeable promise so writes from external request handlers reliably flush — don't `void stream.writeSSE(...)` from sync callbacks; queue and let the SSE async loop `await` each write.
- **Workers**: `RealtimeRoom` Durable Object holds `Map<WebSocket, Meta | null>`. Subscriber meta is base64(JSON)-encoded into the subscribe URL; DO applies the same `matchesCondition` + projection on the publish path.

When emitting events from a new resource, follow `items.ts`: fetch the existing row before DELETE so the `deleted` event carries the last known state.

### Query API for items (Directus-style)

`GET /api/items/:slug` accepts a Directus-shaped query string parsed by `apps/web/src/server/lib/query.ts::parseQuery`:

- `filter=<JSON>` — same DSL as `permissions.condition`. Compiled via `compileCondition` and AND'd with `permission.whereSql`. Filter fields are validated against the collection schema **and** the permission `fields` allow-list (so users can't probe fields they aren't allowed to read).
- `sort=field,-other` — `-` prefix = `DESC`, comma-separated for multi-column. Default: `-created_at`.
- `fields=a,b,c` — projection at SQL level via `resolveProjection`. System columns (`id, created_at, updated_at`, plus `owner_id` if scoped) are always added back so deserialization works.
- `limit` (1-200, default 50) and `offset`.
- `meta=filter_count,total_count` (or `*`) — adds `meta: { filter_count, total_count }` to the response. Each requested count costs one extra `SELECT COUNT(*)`.

Non-list endpoints (`GET /:id`, `POST`, `PATCH`, `DELETE`) don't accept query parameters — they use `requirePermission` only.

### Roles & permissions

Granular permissions live in three system tables: `roles`, `user_roles`, `permissions`. Each `permission` row binds a role to a (collection, action) pair with optional `condition` (mini DSL) and `fields` allow-list.

- **Mini DSL** in `packages/core/src/permission.ts` (types) + `packages/db/src/permission.ts` (compiler). Operators: `_eq, _neq, _in, _nin, _gt, _gte, _lt, _lte, _null, _contains, _starts_with, _ends_with`. Logical: `$and, $or, $not` (top-level keys are implicit `$and`). Variables: `$user.id, $user.email, $user.roles, $now`. The compiler emits a Drizzle `SQL` fragment; never string-concatenate user input.
- **System roles** (auto-seeded on first request): `admin` (bypass), `authenticated` (any signed-in user, additive), `public` (anonymous). The first user to sign up gets `admin`; subsequent users get `authenticated`. Hook lives in `packages/auth/src/index.ts` via `databaseHooks.user.create.after`, wired from `apps/web/src/server/context.ts`.
- **Resolver** in `apps/web/src/server/services/permissions.ts`: loads user's roles + implicit `authenticated`, queries matching permission rows, OR-combines conditions across roles, unions field allow-lists. `null` condition on any matching row = unrestricted (most permissive wins).
- **Middleware** `requirePermission(collection, action)` in `apps/web/src/server/middleware/permission.ts`. Sets `c.var.permission` for the route; routes `WHERE`-AND the resolved `whereSql` and project response by `fields` set. `items.ts` uses this for all 5 CRUD endpoints.
- **`ownerScoped: true`** on a collection is sugar: it auto-seeds permissions for the `authenticated` role with `{ owner_id: { _eq: "$user.id" } }` on read/update/delete and unrestricted create. After seeding, the permission system is the source of truth — toggling `ownerScoped` again only adds missing actions (never removes existing rows).

When wiring a new resource (collections, files, etc.), add a `requirePermission` middleware and apply `c.var.permission.whereSql` / `c.var.permission.fields` rather than rolling your own auth check.

### Hybrid schema ownership: dynamic collections via runtime DDL

User collections live in physical tables **created at runtime** (not in the Drizzle schema). The `collections` metadata row drives a CREATE/ALTER/DROP cycle on `c_<slug>` tables:

- `packages/db/src/field-types.ts` — supported `FieldType` registry (`text, longtext, integer, number, boolean, json, timestamp, uuid`) with PG/SQLite type mappings, identifier validation, reserved system column names (`id, owner_id, created_at, updated_at`).
- `packages/db/src/schema-applier.ts` — `applyCollection`, `dropCollection`, `dropField`, plus `tableExists` / `introspectColumns` helpers. `applyCollection` is **additive only** by design: it never drops or alters existing columns. To remove a field, call `dropField` explicitly.
- `apps/web/src/server/routes/collections.ts` — POST/PATCH wires `applyCollection`, DELETE wires `dropCollection`. The `collections` row is the source of truth for metadata; the physical table is regenerated from it.
- `apps/web/src/server/routes/items.ts` — dynamic CRUD on `c_<slug>` using drizzle's `sql` template + `sql.identifier` for safe identifier interpolation. Per-dialect serialization for `json` (stringify on SQLite), `boolean` (0/1 on SQLite), and `timestamp` (Unix ms on SQLite, `Date` on PG).

When adding a new field type: extend `FieldType` union, add entries to `PG_TYPES` and `SQLITE_TYPES`, and add (de)serialize cases in `apps/web/src/server/routes/items.ts` if the wire format differs from the column format.

### Auth

`packages/auth` wraps `better-auth` with `drizzleAdapter`. `createAuth(db, dialect, config)` picks the right schema (`users`/`sessions`/`accounts`/`verifications`) per dialect — auth tables must stay aligned across both schemas. The whole better-auth router is mounted at `/api/auth/*` (`apps/web/src/server/routes/auth.ts` just delegates to `ctx.auth.handler`). On the admin side, use `@workeros/auth/client` (`createAuthClient` from `better-auth/react`) — never import the server `@workeros/auth` package from the admin app.

### Realtime: same route, different transport

`apps/web/src/server/routes/realtime.ts` checks `env.REALTIME`:

- Workers: forwards to the `RealtimeRoom` Durable Object (`apps/web/src/server/durable-objects/realtime-room.ts`) which fans out via WebSocket.
- Bun: in-process `Map<channel, Set<Listener>>` plus Hono's `streamSSE` for subscribers.

If you change the message shape, change it in both paths and in any admin client code.

### Errors

Throw `AppError(code, message, details?)` from `@workeros/core` in route handlers. The global handler (`apps/web/src/server/middleware/error.ts`) maps the code to the right HTTP status (`UNAUTHORIZED → 401`, `VALIDATION → 422`, etc.). Don't return `c.json({ error: ... }, 4xx)` ad-hoc — use `AppError` so the response shape stays uniform.

### Admin app

The admin SPA is co-located with the server in `apps/web/src/client/`, with `@/` aliased there. Dev runs Vite + miniflare in one process (`@cloudflare/vite-plugin`), so the SPA and API share `localhost:5173` — no proxy needed. Production: same Worker serves both via the Static Assets binding.

### UI package (`@workeros/ui`)

Shared design system in `packages/ui`, built from the shadcn `radix-luma` preset. Single source of truth for tokens, components, and `globals.css`.

- **Importing:** `import { Button } from "@workeros/ui/components/button"`, `import { cn } from "@workeros/ui/lib/utils"`, `import "@workeros/ui/globals.css"`. Subpath exports — no barrel.
- **Adding components:** run `bun run --cwd packages/ui shadcn add <name>` (uses `packages/ui/components.json`, writes into `src/components/`). For app-local components use `bun run --cwd apps/web shadcn add <name>` — that one's `components.json` writes into `apps/web/src/client/components/` but still pulls `cn` from `@workeros/ui/lib/utils`.
- **Tokens & theme:** `packages/ui/src/styles/globals.css` holds the OKLCH palette + Tailwind v4 `@theme` block + `.dark` overrides. `apps/web/src/client/components/theme-provider.tsx` toggles the `.dark` class (press `d` in dev to toggle). `globals.css` uses `@source "../../../../apps/**/*.{ts,tsx}"` and `"../../../../packages/**/*.{ts,tsx}"` so Tailwind picks up class usage from anywhere in the monorepo.
- **Slots/primitives:** components use the `radix-ui` meta-package (`import { Slot } from "radix-ui"`), not the per-component `@radix-ui/react-*` packages. New components added via `shadcn add` will follow the same convention.

## Conventions worth knowing

- TypeScript is strict with `noUncheckedIndexedAccess`. Treat array/Record lookups as possibly `undefined`.
- ESM only (`"type": "module"`); workspace packages are consumed by source path (e.g. `"main": "./src/index.ts"`) — no build step between packages, so editing a `packages/*` file is picked up immediately by both apps.
- Drizzle is on the `1.0.0-beta.22` line. APIs differ from the 0.x docs; pin all `drizzle-orm` / `drizzle-kit` versions together when upgrading.
- `noUncheckedIndexedAccess` plus the dual-dialect union is why `routes/records.ts` casts to `any` in a few places — match that pattern rather than reaching for type assertions per-call.
