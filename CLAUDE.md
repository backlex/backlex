# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the repo root via Bun workspaces.

```bash
bun install
bun run dev                # Vite + Cloudflare miniflare in one process (port 5173)
bun run dev:bun            # Bun-native API only on :8787 (no admin SPA)
bun run typecheck          # all workspaces
bun run lint               # biome lint apps + packages (no formatter)
bun run lint:fix           # biome lint --write (safe auto-fixes)
bun run build              # vite build (admin SPA + worker bundle)
bun run deploy             # vite build + wrangler deploy (CF)
bun run test               # bun test (apps/web/tests/, fresh temp SQLite per spec)
bun backlex <cmd>          # backlex CLI (packages/cli/bin/backlex.ts) — see docs/sdk-and-cli.md
bun run --cwd apps/web i18n:extract  # lingui extract → apps/web/src/client/locales/*.po

# DB — pick the dialect explicitly; there is no shared command:
bun run db:generate:pg     # drizzle-kit generate against packages/db/src/pg/schema.ts
                           # ⚠ requires an interactive TTY (drizzle-kit prompts
                           # on column renames); run from your own terminal.
bun run db:generate:sqlite
bun run db:migrate:pg      # needs DATABASE_URL; also CREATE EXTENSION vector
bun run db:migrate:sqlite  # writes to ./.data/backlex.sqlite (Bun SQLite)
bun run db:migrate:d1      # apply drizzle/sqlite migrations to a local D1
bun run db:migrate:d1:remote # same, but to the deployed CF D1 (--remote)
bun run db:studio          # drizzle-kit studio against the active dialect config
```

Tests run on Bun's native runner (`bun:test`). The suite lives in `apps/web/tests/` and is invoked via `bun test` (from the repo root or `apps/web`). Each spec spins a fresh temp SQLite in-process through `tests/setup.ts::makeHarness`; no external server / DB is required. CI runs the same `bun run test` as a pre-deploy gate (`.github/workflows/test.yml`, on every PR and every push to `main`).

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

Every working session runs on its own branch. Merging into `main` triggers two independent paths:

- **Cloudflare Workers Builds (native git integration)** — the `workeros-api` Worker is connected to this repo from the CF dashboard. On every push to `main` it runs the build command (`bun run db:migrate:d1:remote && bun run build`) and then deploys with `cd apps/web && bunx wrangler deploy`. No GitHub secrets needed; CF Builds is auto-authenticated.
- **`.github/workflows/test.yml`** — runs lint + typecheck + `bun test` + `bun run build:targets` on every PR **and** every push to `main`. Acts as a redundant gate that catches regressions in the four-runtime build matrix (Bun / CF / Vercel / Netlify) which Workers Builds doesn't exercise on its own.

The repo also ships native-git deploy configs for **Vercel** (`vercel.ts` + Build Output API) and **Netlify** (`netlify.toml` + `apps/web/netlify/functions/`). All three platforms (CF / Vercel / Netlify) use their own native git integration — no GitHub Actions deploy workflow exists for any of them. Runtime caveats live in `docs/deployment.md`.

**Always create a new branch BEFORE doing any work.** This is mandatory — do not edit files, run commands that mutate state, or otherwise begin a task while still checked out on `main`. The very first step of every new task is:

```bash
git checkout main && git pull origin main
git checkout -b feat/<short-topic>
```

If you find yourself on `main` with uncommitted changes when a task begins, stop and create the branch first (`git stash` + branch + `git stash pop` is fine).

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

# 4. Push — this triggers Cloudflare Workers Builds (deploy) + test.yml (gate)
git push origin main

# 5. Confirm the test gate started (Actions)
gh run list --workflow test.yml --limit 1
```

After pushing, report the test.yml run URL back to the user. The actual Worker deploy runs in **Cloudflare dashboard → Workers & Pages → workeros-api → Deployments** (not visible to `gh`). Don't claim "deployed" until both are green — `gh run watch` confirms the gate; the CF dashboard (or `wrangler deployments list`) confirms the deploy.

**After the deploy run goes green**, smoke-test the change against the live URL with the puppeteer MCP server (`mcp__puppeteer__puppeteer_*` tools). The default target is the production deploy unless the user names a specific URL. Drive the relevant flow end-to-end (sign in, exercise the feature touched by this branch, watch for console/network errors via `puppeteer_evaluate`) and screenshot the result. Report what you tested and what you saw — don't call it shipped without that pass.

## Architecture (one-screen orientation)

For the full picture, see `docs/architecture.md`. The minimum an agent needs to know up front:

### Repo layout

Bun workspaces — every package is source-consumed (no build step between them), so editing a `packages/*` file is picked up immediately by both apps.

- `apps/web` — Hono API + React admin SPA in one workspace.
- `apps/docs` — Astro Starlight user-facing docs site; the Worker serves it at `/docs` after build.
- `packages/db` — dual-dialect Drizzle (PG + SQLite) + dynamic-DDL applier + permission DSL compiler.
- `packages/auth` — better-auth wrapper; `createAuth(db, dialect, config)`.
- `packages/core` — runtime-agnostic types: `Env`, `AppError`, adapter contracts, permission DSL types.
- `packages/ui` — shared shadcn design system (see below).
- `packages/cli` — `backlex` binary, invoked via `bun backlex <cmd>`; see `docs/sdk-and-cli.md`.
- `packages/client` — public TypeScript SDK end-user apps consume against the backlex API.

### One app, four runtimes

`apps/web` ships **both** the Hono API and the React admin SPA. `bun run dev` spins both up on port 5173 via `@cloudflare/vite-plugin`. Production: one Worker serves the SPA (Static Assets binding) + the API. Layout under `apps/web/src/`:

- `client/` — Vite + React + Tailwind v4 admin (`@/` alias). Entry `client/main.tsx`.
- `server/` — Hono app + adapters + routes + services. Four entries in `server/entries/`: `bun.ts`, `worker.ts`, `vercel.ts`, `netlify.ts`.
- `server/app.ts` — `createApp(env)` builds the Hono app, mounts middleware + routes.
- `server/env.ts` — runtime-agnostic `Env` interface; Cloudflare binding fields are optional and only present on Workers.

The admin's API client (`client/lib/api.ts`) defaults to relative `/api/...` paths, so same-origin deploys work without `VITE_API_URL`. Set `VITE_API_URL` only for cross-origin setups.

**Anything runtime-specific must stay behind the adapter layer** — do not branch on `typeof process` etc. inside route code. Adapter contracts live in `packages/core/src/adapters/{storage,vector,email,image,saml,ldap}.ts`; concrete implementations live in `apps/web/src/server/adapters/*`. The selection rules (dialect, db driver, storage, vector, email, realtime transport, saml, ldap, smtp) live in `apps/web/src/server/context.ts::buildContext(env)` — see the adapter table in `docs/architecture.md` before adding a new one.

### Hybrid schema ownership

System tables live in `packages/db/src/{pg,sqlite}/schema.ts` (Drizzle, dual-dialect — **always edit both files** when changing schema). User collections live in **physical tables** whose name is whatever the collection metadata row's `physical_table` column says — the default the unified create endpoint picks is `c_<tenantPrefix12>_<slug>`, but adopted collections can wrap any existing table name.

`POST /api/collections` is the single create endpoint:
- `adopted: false` (default) — backlex creates the physical table (managed).
- `adopted: true` — table already exists; backlex only writes the metadata row.

`packages/db/src/schema-applier.ts::applyCollection` is **additive only**: it never drops or alters existing columns and short-circuits when `def.adopted === true`. Field removal goes through `dropField` so admins audit destructive moves. See `docs/adopting-tables.md` for the full lifecycle.

### Errors

Throw `AppError(code, message, details?)` from `@backlex/core` in route handlers. The global handler (`apps/web/src/server/middleware/error.ts`) maps the code to the right HTTP status (`UNAUTHORIZED → 401`, `VALIDATION → 422`, etc.). **Don't return `c.json({ error: ... }, 4xx)` ad-hoc** — use `AppError` so the response shape stays uniform.

### Permissions DSL (one-paragraph version)

Granular permissions live in `roles` + `user_roles` + `permissions`. Each `permission` row binds a role to a (collection, action) pair with optional `condition` (mini DSL) and `fields` allow-list. The DSL compiles to a Drizzle `SQL` fragment for REST/GraphQL filters and to an in-memory predicate for realtime filtering — same operators, same variables (`$user.id`, `$user.email`, `$user.roles`, `$tenant.id`, `$now`). When wiring a new resource, add a `requirePermission(collection, action)` middleware and apply `c.var.permission.whereSql` / `c.var.permission.fields`. Full reference: `docs/permissions.md`.

## UI package (`@backlex/ui`)

Shared design system in `packages/ui`, built from the shadcn `radix-luma` preset. Single source of truth for tokens, components, and `globals.css`.

- **Importing:** `import { Button } from "@backlex/ui/components/button"`, `import { cn } from "@backlex/ui/lib/utils"`, `import "@backlex/ui/globals.css"`. Subpath exports — no barrel.
- **Adding components:** run `bun run --cwd packages/ui shadcn add <name>` (uses `packages/ui/components.json`, writes into `src/components/`). For app-local components use `bun run --cwd apps/web shadcn add <name>` — that one's `components.json` writes into `apps/web/src/client/components/` but still pulls `cn` from `@backlex/ui/lib/utils`.
- **Tokens & theme:** `packages/ui/src/styles/globals.css` holds the OKLCH palette + Tailwind v4 `@theme` block + `.dark` overrides. `apps/web/src/client/components/theme-provider.tsx` toggles the `.dark` class (press `d` in dev to toggle).
- **Slots/primitives:** components use the `radix-ui` meta-package (`import { Slot } from "radix-ui"`), not the per-component `@radix-ui/react-*` packages.
- **Scrollable areas:** never put a raw `overflow-auto` / `overflow-y-auto` / `overflow-x-auto` on a scroll container — always use `<ScrollArea>` from `@backlex/ui/components/scroll-area` so the scrollbar styling stays consistent. Height caps go on `viewportClassName`; fill/visual classes (`min-h-0 flex-1`, `w-full`, `border*`, `rounded-*`, `bg-*`) go on `className`; layout (`flex`, `grid`, `gap-*`), padding, and event handlers stay on an inner `<div>` inside the `ScrollArea`. For a dialog/sheet whose body scrolls, give `DialogContent` `flex flex-col overflow-hidden` and wrap only the body in `<ScrollArea className="min-h-0 flex-1">` so the header/footer stay pinned.

## Conventions worth knowing

- TypeScript is strict with `noUncheckedIndexedAccess`. Treat array/Record lookups as possibly `undefined`.
- ESM only (`"type": "module"`); workspace packages are consumed by source path (e.g. `"main": "./src/index.ts"`) — no build step between packages.
- Drizzle is on the `1.0.0-beta.22` line. APIs differ from the 0.x docs; pin all `drizzle-orm` / `drizzle-kit` versions together when upgrading.
- `noUncheckedIndexedAccess` plus the dual-dialect union is why `routes/items.ts` casts to `any` in a few places — match that pattern rather than reaching for type assertions per-call.
- Migrations are **hand-written SQL** under `packages/db/drizzle/{pg,sqlite}/`. `db:generate:*` only refreshes the drizzle snapshot. Both dialects must be edited in lockstep.

## Where to dig deeper

Long-form guides live under `docs/`. CLAUDE.md is the always-loaded summary; reach for these when you need the full surface area of a feature.

| Topic | Guide |
|---|---|
| Docs site landing | `docs/index.md` |
| Architecture overview | `docs/architecture.md`, `docs/DESIGN.md` |
| Deployment (CF / Vercel / Netlify) | `docs/deployment.md` |
| Testing (3-layer pyramid + CI gates) | `docs/testing.md` |
| Service map (route + service inventory) | `docs/service-map.md` |
| Permissions DSL | `docs/permissions.md` |
| Query API (REST) | `docs/querying.md` |
| GraphQL | `docs/graphql.md` |
| Realtime / SSE | `docs/realtime.md` |
| Storage + transforms | `docs/storage.md` |
| Functions sandbox | `docs/sandbox.md` |
| Advisor rules | `docs/advisor.md` |
| Auth planes (admin vs workspace end-users) | `docs/auth-planes.md` |
| SSO (SAML / LDAP) | `docs/sso.md` |
| API keys, access tokens, email & OAuth | `docs/api-keys-and-email.md` |
| Adopting existing tables | `docs/adopting-tables.md` |
| Locale + timezone | `docs/locale-timezone.md` |
| Admin SPA i18n (Lingui) | `docs/admin-i18n.md` |
| CLI + SDK | `docs/sdk-and-cli.md` |
| Ask AI page | `docs/ask-ai.md` |
