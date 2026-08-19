# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the repo root via Bun workspaces.

```bash
bun install
bun run dev                # Vite + Cloudflare miniflare in one process (port 5173), on the Bun runtime
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

- **Cloudflare Workers Builds (native git integration)** — the `backlex-admin` Worker is connected to this repo from the CF dashboard. On every push to `main` it runs the build command (`bun run db:migrate:d1:remote && bun run build`) and then deploys with `cd apps/web && bunx wrangler deploy`. No GitHub secrets needed; CF Builds is auto-authenticated.

  **Two settings live only in the CF dashboard and are invisible from this repo — check them before blaming the code.** (1) `BUN_VERSION` is pinned to `1.3.14` on **both** the `backlex-admin` and `backlex-website` triggers. The runner defaults to bun `1.2.15`, which reports `process.version` as `v22.6.0`; astro 7 rejects that (`>=22.12.0`) and killed every website deploy in 24 s until it was pinned, while vite merely warns. Bun has no version file — `BUN_VERSION` is the only lever (Node has `.nvmrc`/`.node-version`). Do not raise it to match this machine without checking `bun --revision`: the local bun is `1.4.0-canary.1`, which is not a published release and CF cannot install it. (2) The deploy command was `cd apps/web && bun run deploy`, which re-ran the *entire* `vite build` a second time after the build phase had already run it; it is now plain `bunx wrangler deploy`, matching what this file documents.
- **`.github/workflows/test.yml`** — runs lint + typecheck + `bun test` + `bun run build:targets` on every PR **and** every push to `main`. Catches regressions in the eight-runtime build matrix that Workers Builds doesn't exercise on its own.

  **It runs ALONGSIDE the CF deploy, not before it** — both start on the same push — so by itself it is a tripwire, not a gate. Two things narrow that, and the second needs you: `scripts/require-green-checks.ts` runs first inside `bun run build` and refuses a commit whose test run is already known red; and `test.yml`'s `deploy` job triggers the Cloudflare build *after* the suite passes, which is **inert until `CF_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_BUILD_TRIGGER_UUID` exist as repo secrets and the automatic branch trigger is turned off in the CF dashboard**. Waiting inside the build is not an option: the `test` job takes ~16 minutes and CF kills a build at 20.

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

# 6. After the gate is green, prove WHICH bundle is live
bun scripts/verify-deploy.ts --marker <string-only-in-this-commit> --wait 600

# 7. Reclaim the shipped branch's tree. Step 3's merge already fires this via
#    lefthook's post-merge hook, so this is a no-op unless the hook was skipped;
#    run it explicitly when you merged with --no-verify or merged elsewhere.
bun scripts/cleanup-worktrees.ts
git branch -d <feat/branch-name>
```

**`git push` runs the full pre-push suite (~5-6 min): lint + typecheck + `bun test` + `build:targets`.** Give the command a generous timeout — never `--no-verify`.

After pushing, report the test.yml run URL back to the user. Don't claim "deployed" until both are green — `gh run watch` confirms the gate, and `scripts/verify-deploy.ts` confirms the deploy.

**Agent worktrees are collected on merge.** Parallel agent sessions each get a worktree under `.claude/worktrees/`, nothing removes them when the session ends, and each carries its own `node_modules` — left alone the directory reaches tens of GB. `lefthook.yml`'s `post-merge` job runs `scripts/cleanup-worktrees.ts`, which removes only worktrees that are orphaned, or merged into `main` + clean + idle for an hour; a dirty or unmerged tree is reported and kept. Note that a worktree's `.git` is an **absolute** path into `.git/worktrees/`, so moving or renaming the repo orphans every one of them at once — after such a move they are unreadable by git and only `rm` clears them.

**Do not use `wrangler deployments list` to confirm a deploy.** It is stale for Workers Builds deploys (the native git integration this repo uses) and will show a days-old deployment while the new bundle is already serving. `scripts/verify-deploy.ts` checks behaviourally instead: it probes `/health` (**not** `/api/health`, which is a 404 that reads exactly like "deploy hasn't landed"), walks the entry chunks *and the lazy chunks they reference* (admin pages are lazy — grepping `index.html`'s chunks alone finds nothing), and fails if a marker you know is new is absent. Pick a marker that exists only in the commit just shipped: a new provider id, a brand hex, a fresh route path.

**Almost none of a CF build is compilation — it is the D1 migration step.** Measured on a green 16.0-minute build: migrations ran 0.5m → 15.5m, then the whole `vite build` took **12 seconds** (`backlex_admin` env 2.37 s + client env 9.02 s). If a build ever creeps back toward the runner's 31-minute kill, read the migration timestamps first; the bundler is not where the minutes go.

All 120 migrations used to replay on every remote deploy, and the cause was a **self-reinforcing loop that failed silently** — worth knowing in full, because every layer of it hid the next. The ledger writes always worked; production had accumulated **34,811 rows for 121 distinct hashes**, one set per deploy across ~290 deploys. Reading them back with `SELECT hash` produced ~2.8 MB on stdout, which overflowed `spawnSync`'s 1 MB default `maxBuffer`. That overflow is invisible in the worst possible shape: `status: null`, stdout truncated mid-JSON, and **stderr empty**. So the parse failed, the empty result read as "nothing recorded", all 120 migrations replayed, and the replay appended 120 more rows for next time. The read guard was `if (!r.ok && r.stderr)`, and with stderr empty it printed nothing at all.

Fixed by three things that must stay together, pinned by `apps/web/tests/migrate-d1-ledger.test.ts`: the query selects `DISTINCT` (121 rows, not 34,811), the spawn raises `maxBuffer`, and a failed read now says so unconditionally instead of passing as an empty ledger. A separate earlier layer is also fixed and worth remembering — the query is written space-free because a spaced `--command=` argv element reached wrangler on the runner split into four tokens (`Unknown arguments: hash, FROM, __drizzle_migrations;`); see the comment above `LEDGER_SELECT`. **The 34,690 duplicate rows are still in production**; the loop is stopped, but the table has not been compacted.

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

**Vite runs on Bun, not Node.** `dev`, `build`, `preview` and `deploy` all invoke it as `bunx --bun vite …` (the same form `apps/site` / `apps/docs` use for Astro), so Vite + miniflare/workerd + HMR run under the Bun runtime. The dev server needs Bun's `ws` client `'upgrade'` event, which only became usable in the 1.4.0 canary line — on an older Bun it hangs forever at `⎔ Establishing remote connection...`, so check `bun --revision` first if you see that. The production Worker bundle is **byte-identical** under either runtime (all 279 files); only one client chunk (`preload-helper`) differs, and only in minifier variable naming, which cascades content hashes across the SPA chunks. Note that **`ps` reports the process as `node`** because Bun spoofs `argv[0]`; the honest check is `lsof -p <pid> | awk '$4=="txt"'`, which shows the real `bun` binary.

**What deliberately stays on Node**, so nobody "finishes the job" and breaks it:

| Script | Why |
|---|---|
| `typecheck` (`tsc`) | `NODE_OPTIONS=--max-old-space-size=8192` is a **V8** flag; Bun uses JavaScriptCore and ignores it, dropping the only guard on a project whose working set already exceeds an 8 GB machine. The bottleneck is type complexity, not runtime — see `docs/performance.md`. |
| `i18n:extract` (`lingui`) | Hangs indefinitely under `--bun` (no output at all). |
| `astro check` | Imports the TypeScript compiler API, which 7.0 shipped without. |
| `wrangler deploy` | Works under `--bun` for `--version`, but a real deploy was never exercised; no upside, since CF Builds runs it on its own runner. |
| `build` in `packages/cli` / `packages/client` (`tsup`) | Its dts step fails on **both** runtimes under TypeScript 6.0 (`TS5101: baseUrl is deprecated`) — a pre-existing break, not a runtime question. |
| `drizzle-kit` | Prompts on column renames; needs a real TTY. |
| `start:node` | Runs the Node build target — Node is the point. |

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
- **Scrollable areas:** never put a raw `overflow-auto` / `overflow-y-auto` / `overflow-x-auto` on a scroll container — always use `<ScrollArea>` from `@backlex/ui/components/scroll-area` so the scrollbar styling stays consistent. Height caps go on `viewportClassName`; fill/visual classes (`w-full`, `border*`, `rounded-*`, `bg-*`) go on `className`; layout (`flex`, `grid`, `gap-*`), padding, and event handlers stay on an inner `<div>` inside the `ScrollArea`.
- **Dialog/sheet body scroll:** give `DialogContent` `flex flex-col overflow-hidden max-h-[Xvh]`, pin header/footer with `shrink-0`, and cap the body's ScrollArea **viewport** — `<ScrollArea viewportClassName="max-h-[calc(Xvh-10rem)] max-[640px]:max-h-[calc(Xvh-15rem)]">`. Do NOT rely on `className="min-h-0 flex-1"` to size a dialog body — Radix's viewport (`size-full`/`h-full %`) doesn't resolve against a `flex-1` parent in a `max-h` dialog, so it grows to content height and draws OVER the footer. The mobile (`max-[640px]:`) budget is larger because mobile chrome is taller (the description wraps + the footer stacks via `flex-col-reverse`). The ScrollArea component already forces its content wrapper to `display:block` so `w-full` inputs don't blow past the viewport.

## UI/UX + responsive review (required)

Every admin/tenant/public UI change must be verified at **mobile (~390×740) AND desktop** before it's done — not just typecheck/lint/`bun test` and not just the default desktop width. Most UI regressions here are mobile-only (horizontal overflow, modal top/bottom clipping, footer overlapping the body). Drive the real screen with the puppeteer MCP tools at a phone viewport (`defaultViewport:{width:390,height:740}`) and **measure geometry in `puppeteer_evaluate` (element rects) — don't eyeball one screenshot**, clipping is easy to miss. Checklist:

- **No horizontal overflow:** every field's `getBoundingClientRect().right <= container.right`. Watch for a `Select` whose long selected label+hint forces a grid column wider than the viewport (add `min-w-0` to the trigger + `[&>*]:min-w-0` on grid `DialogContent`).
- **No modal clipping:** `DialogFooter` sits inside the dialog and on-screen, and the body scrolls (use the viewport-cap pattern above).
- **Conventions:** on mobile, nav toggles + action buttons hug the right edge (gate with `sm:`). Loading states are **skeletons** (`Skeleton` / per-page `*Skeleton`), never a plain "Loading…" text or a bare spinner — button busy labels ("Saving…") are fine. Fields with a finite value set are **directly selectable** (dropdown / auto-select, with a "Custom…" escape hatch when the backend accepts open-ended values), not raw free-text; label non-obvious fields with a one-line helper.
- **Mutations are optimistic.** Every create/update/delete/drop/toggle/reorder must update the UI **immediately**, then reconcile — never make the user wait on a request + refetch before the change shows. Pattern: snapshot state → apply optimistic next-state (and close any dialog) → `await api.mutate()` → on success optionally reconcile with a background `list()`; on error roll back to the snapshot + error toast. React Query: `onMutate` patches the raw query cache, `onError` restores, `onSettled` invalidates. Do NOT ship the `await api.mutate(); const r = await api.list(); setState(r.data)` (await-then-refetch) shape — it leaves the row visibly stale until the round-trip ends.
- Do the local mobile pass **before** publish and the live pass **after** deploy.

## Conventions worth knowing

- TypeScript is strict with `noUncheckedIndexedAccess`. Treat array/Record lookups as possibly `undefined`.
- ESM only (`"type": "module"`); workspace packages are consumed by source path (e.g. `"main": "./src/index.ts"`) — no build step between packages.
- Drizzle is on the `1.0.0-beta.22` line. APIs differ from the 0.x docs; pin all `drizzle-orm` / `drizzle-kit` versions together when upgrading.
- **`vite` runs on `8.2.1`. The old exact pin to `8.0.13` was lifted 2026-08-15, because the reason for it did not survive being measured.** Keep the story, because the wrong version of it cost two advisories and a lot of build minutes. Vite 8 bundles rolldown, and rolldown ≥ 1.0.3 does have a real open deadlock on CPU-constrained CI when a JS plugin's `transform` hook calls a native NAPI addon — for us `@tailwindcss/vite` → `@tailwindcss/oxide` (rolldown [#10102](https://github.com/rolldown/rolldown/issues/10102), closed `not_planned`; [#10664](https://github.com/rolldown/rolldown/issues/10664)). Two Cloudflare deploys really did hang at exactly 31 minutes on `8.2.1`, which is why it was pinned back. The upstream env-var workarounds (`TOKIO_WORKER_THREADS`, `RAYON_NUM_THREADS`, `UV_THREADPOOL_SIZE`) were tried and none help.

  **Why the pin came off.** The bump to `8.2.1` and the move to `bunx --bun vite build` landed in the *same* push, only the first was reverted, and `8.2.1` had also produced a green build — so the version was never actually isolated. Measured properly as an A/B on the playground trigger, which compiles the same `apps/web` bundle through the same oxide NAPI path: **13 runs on `8.2.1` / rolldown `1.2.4` — 7/7 green on Node, 6/6 green under `--bun`, zero hangs, 1.1–2.1 minutes each.** What every original hang shared was a build that first spent ~15 minutes replaying 120 migrations, and the deadlock is CPU-starvation sensitive — that load is what starved it. Fixing the migration ledger removed the trigger. Bumping also closed the two advisories `8.0.13` carried (GHSA-fx2h-pf6j-xcff, GHSA-v6wh-96g9-6wx3), both Windows-only and dev-server-only.

  **If a build hangs at 31 minutes again, do not reach for the vite version first** — look at what else is loading the runner. The drift that IS still real is a declared pin failing to constrain a transitive copy, and `apps/web/tests/vite-pin-lockfile.test.ts` guards exactly that: it compares what `bun.lock` RESOLVED against what package.json DECLARES, with no version hardcoded, so a deliberate bump passes and a silent divergence does not.

  **Declaring the pin does not enforce it — only the lockfile does, and `apps/web/tests/vite-pin-lockfile.test.ts` is what checks.** `apps/site/package.json` already named `vite: 8.0.13`, and astro still resolved its own nested `vite@8.2.1` (→ rolldown `1.2.4`) straight past it: a direct dependency pin does not constrain a dependency's own dependency. The obvious repair does not work either — Bun answers a scoped entry with `warn: Bun currently does not support nested "resolutions"` and ignores it, and that warning surfaces only in the CI install log, so locally the entry looks like it worked. A blanket `"vite"` resolution is not an option either, because `apps/docs` runs astro 6 and requires `vite ^7.3.2`. So what holds the pin is the resolved `bun.lock` plus CI's `--frozen-lockfile` — a state, not a constraint, which can drift back on any re-resolution. Check what was RESOLVED, never what a package.json asked for: `grep -oE '"[^"]*vite": \["vite@[0-9.]+' bun.lock`. **Known cost:** `8.0.13` carries two open advisories — GHSA-fx2h-pf6j-xcff (high, `server.fs.deny` bypass) and GHSA-v6wh-96g9-6wx3 (medium, launch-editor NTLM disclosure), both fixed in `8.0.16`. Both are Windows-only and dev-server-only, and vite never ships to production, so the exposure here is nil while the deadlock is not. Move to `8.0.16`+ once rolldown fixes the deadlock — verify by watching a real Cloudflare build to completion, not a local build.
- `noUncheckedIndexedAccess` plus the dual-dialect union is why `routes/items.ts` casts to `any` in a few places — match that pattern rather than reaching for type assertions per-call.
- Migrations are **hand-written SQL** under `packages/db/drizzle/{pg,sqlite}/`. `db:generate:*` only refreshes the drizzle snapshot. Both dialects must be edited in lockstep.

## Where to dig deeper

Long-form guides live under `docs/`. CLAUDE.md is the always-loaded summary; reach for these when you need the full surface area of a feature.

| Topic | Guide |
|---|---|
| Docs site landing | `docs/index.md` |
| Architecture overview | `docs/architecture.md`, `docs/DESIGN.md` |
| Performance (read-path wins + backlog) | `docs/performance.md` |
| Deployment (CF / Vercel / Netlify) | `docs/deployment.md` |
| Testing (3-layer pyramid + CI gates) | `docs/testing.md` |
| Service map (route + service inventory) | `docs/service-map.md` |
| Schema templates (catalog + groups + bundles + extract) | `docs/templates.md` |
| Permissions DSL | `docs/permissions.md` |
| Row-level security (DSL → Postgres policies) | `docs/rls.md` |
| Audit logs + sensitive-read auditing | `docs/audit-logs.md` |
| Data-subject erasure (GDPR) | `docs/erasure.md` |
| Distributed tracing (traceparent + Traces panel) | `docs/tracing.md` |
| Usage metering + quotas (per-key limits, plan limits) | `docs/usage-metering.md` |
| Product analytics + crash reporting | `docs/product-analytics.md` |
| Tag manager (GTM-style third-party tags) | `docs/tag-manager.md` |
| Cookie consent (policy a site publishes) | `docs/cookie-consent.md` |
| Query API (REST) | `docs/querying.md` |
| Full-text & hybrid search | `docs/full-text-search.md` |
| GraphQL | `docs/graphql.md` |
| Realtime / SSE | `docs/realtime.md` |
| Broadcast channels (application-owned pub/sub) | `docs/broadcast-channels.md` |
| Reactive / live queries (SDK + React `useLiveQuery`) | `docs/reactive-queries.md` |
| Offline-first sync (changefeed + client store) | `docs/offline-sync.md` |
| Change data capture (changefeed → webhook / bucket) | `docs/cdc.md` |
| Push messaging (FCM / APNs / Web Push) | `docs/push-messaging.md` |
| SMS messaging (Twilio / Amazon SNS) | `docs/sms-messaging.md` |
| Document generation (PDF) | `docs/documents.md` |
| E-signature (native signing flow) | `docs/e-signature.md` |
| Approvals (a flow waits on a person) | `docs/approvals.md` |
| Availability & booking (public booking page) | `docs/booking.md` |
| Storage + transforms | `docs/storage.md` |
| S3-compatible endpoint (rclone / aws-cli / mc) | `docs/s3.md` |
| Resumable uploads (TUS) | `docs/resumable-uploads.md` |
| Functions sandbox | `docs/sandbox.md` |
| Extensions (installable panels/field editors/hooks) | `docs/extensions.md` |
| Durable job queue (retry / DLQ / scheduled) | `docs/jobs.md` |
| Flows (event/cron/manual/webhook automation) | `docs/flows.md` |
| AI agents (reason→act loop + tools + memory) | `docs/agents.md` |
| Outbound webhooks (signing + retry + auto-disable) | `docs/webhooks.md` |
| Integrations (provider registry + durable delivery + flow op) | `docs/integrations.md` |
| Marketplace listings (category mapping + publish + verdict) | `docs/marketplace-listings.md` |
| Sync hooks (an app participates in a write) | `docs/sync-hooks.md` |
| Auth hooks (an app participates in its end-users' auth) | `docs/auth-hooks.md` |
| Payments (Stripe / Polar / Lemon Squeezy sync) | `docs/payments.md` |
| Backup / restore + per-collection export-import | `docs/backup-restore.md` |
| Draft / publish + scheduled publishing | `docs/draft-publish.md` |
| Feature flags + remote config | `docs/feature-flags.md` |
| Playground / demo mode (public demo instance) | `docs/demo-mode.md` |
| Public form builder (embeddable forms) | `docs/forms.md` |
| Embedded BI dashboards (panels + public embed) | `docs/embedded-dashboards.md` |
| KPIs (one formula every surface reads a figure from) | `docs/kpis.md` |
| Scheduled reports (dashboard → PDF → email) | `docs/reports.md` |
| Advisor rules | `docs/advisor.md` |
| Auth planes (admin vs workspace end-users) | `docs/auth-planes.md` |
| Captcha + audited impersonation | `docs/captcha-impersonation.md` |
| JWT signing keys (standby → in use → revoked) | `docs/signing-keys.md` |
| OAuth provider (client registry + grants) | `docs/oauth-provider.md` |
| Organizations / teams (app-plane B2B grouping) | `docs/app-organizations.md` |
| SSO (SAML / LDAP) | `docs/sso.md` |
| Third-party auth (trust an external JWT issuer) | `docs/third-party-auth.md` |
| API keys, access tokens, email & OAuth | `docs/api-keys-and-email.md` |
| Adopting existing tables | `docs/adopting-tables.md` |
| Hashed fields (passwords/secrets) | `docs/hashed-fields.md` |
| Field conditions (required/readonly/hidden) | `docs/field-conditions.md` |
| Field validation (per-field constraints + cross-field rules) | `docs/field-validation.md` |
| Rollup fields (a parent total kept from its child rows) | `docs/rollups.md` |
| Sequence fields (a document number the server issues) | `docs/sequences.md` |
| Order fields (the place a row holds in a hand-arranged list) | `docs/ordering.md` |
| Slug fields (the URL handle a row is addressed by) | `docs/slugs.md` |
| Geo fields (where a row is, and what is near it) | `docs/geo.md` |
| Money fields (an amount and the currency it is in) | `docs/money.md` |
| Phone fields (a number stored as canonical E.164) | `docs/phone.md` |
| Email fields (an address stored the one way every mail server accepts) | `docs/email.md` |
| URL fields (a web address stored the one way every client resolves it) | `docs/urls.md` |
| Date ranges (a period, and what overlaps it) | `docs/date-ranges.md` |
| Number/percent display formatting | `docs/number-formatting.md` |
| Status transitions (which value a status may move to) | `docs/status-transitions.md` |
| Item views (Table / Kanban / Gallery / Calendar) | `docs/item-views.md` |
| Migrating an external DB in (`backlex import-db`) | `docs/migrating-in.md` |
| Schema versions (migration diffing / branching) | `docs/schema-versions.md` |
| Locale + timezone | `docs/locale-timezone.md` |
| Admin SPA i18n (Lingui) | `docs/admin-i18n.md` |
| CLI + SDK | `docs/sdk-and-cli.md` |
| SDK React bindings (session + hooks) | `docs/client-react.md` |
| Ask AI page | `docs/ask-ai.md` |
