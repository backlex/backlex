---
title: Testing
description: Three-layer test pyramid that gates every change against business logic, build artifacts, and real-runtime behavior.
---

Backlex builds the same source tree into bundles for every deploy target —
Bun and Node self-host, Cloudflare Workers, Vercel, Netlify, and the serverless
clouds (see [Deployment](/deployment)). The `build:targets` CI gate compiles the
Workers / Vercel / Netlify / Node bundles on every run. To keep that
multi-runtime promise honest, the test setup runs at three layers, each catching
what the layer above can't see.

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3 — runtime-smoke (CI matrix: bun, vercel, netlify)   │
│   Boots each runtime end-to-end, exercises real HTTP        │
│   Catches: bundle import errors, runtime-conditional        │
│   adapter selection, cookie / auth round-trips, cron auth   │
├─────────────────────────────────────────────────────────────┤
│ Layer 2 — build-targets (pre-push + CI)                     │
│   Bundles the worker (wrangler dry-run), vercel function    │
│   (Build Output API), and netlify function in parallel      │
│   Catches: missing shims, raw-TCP imports leaking into the  │
│   worker bundle, Bun-only APIs in Node-targeted bundles     │
├─────────────────────────────────────────────────────────────┤
│ Layer 1 — bun test (pre-push + CI)                          │
│   In-process Hono app on a fresh temp SQLite per spec       │
│   Catches: business logic, permissions DSL, route handlers, │
│   migrations, all reproducible CRUD scenarios               │
└─────────────────────────────────────────────────────────────┘
```

A change that breaks Layer 1 is broken everywhere. A change that
passes Layer 1 but breaks Layer 2 is broken on at least one platform.
A change that passes Layer 2 but breaks Layer 3 boots fine but
serves traffic incorrectly on at least one platform.

## Layer 1 — `bun test` (business logic)

Lives in `apps/web/tests/*.test.ts`. The harness in `tests/setup.ts`
spins up a fresh temp SQLite per spec and calls `app.fetch(req)`
in-process — no network, no real DB host, no Worker isolate. Runs
in milliseconds per file.

```bash
bun test                 # all suites
bun test tests/auth.test.ts   # single suite
```

The `pg-smoke.test.ts` file covers the Postgres dialect path via
`pglite` (WASM Postgres + pgvector) so dual-dialect bugs surface in
the same suite.

### Client render tests (`tests/client/*.test.tsx`)

The same `bun test` run also drives React component render tests under
`tests/client/`. Two preloads (configured in `apps/web/bunfig.toml`) make this
work in-process alongside the API specs:

- `lingui-macro.ts` — a Bun loader that runs the Lingui compile-time macro on
  imported `src/client` files (bun test doesn't run vite), mirroring the
  `linguiMacro()` vite plugin. Without it, any component importing `@lingui/*`
  throws when rendered.
- `happydom.ts` — registers a happy-dom DOM, then restores Bun's native
  `fetch`/`Request`/`Response`/`AbortSignal`/etc. so the ~600 API specs sharing
  the process keep using the real networking layer.

Use `renderWithProviders` from `tests/client/render.tsx` (React Query + Lingui +
MemoryRouter) for components that need app context. Keep tests isolated: any spec
that mutates a global (e.g. `navigator`) must restore it in `afterAll`, or it
leaks into the render tests later in the run.

**Known follow-ups:** the `@/` path alias isn't resolved under bun test yet, so
render tests currently import components by relative path and cover components
that don't import via `@/`. Wiring the alias (and generated row types to kill
snake_case/camelCase drift) would widen coverage.

## Lint ratchet (next targets)

`biome.json` enforces the dead-code rules (`noUnusedImports` /
`noUnusedVariables` / `noUnusedFunctionParameters` → `error`). Two rules remain
deliberately off, each a tracked follow-up:

- `useExhaustiveDependencies` — **34 existing violations** (missing/extra React
  hook deps; some carry stale `// eslint-disable-next-line react-hooks/
  exhaustive-deps` comments biome doesn't honor). These are real stale-closure
  risk, but each fix is behaviour-sensitive and needs a per-component UI check —
  not a bulk auto-apply. Triage them in a focused pass, then flip to `error`.
- `noExplicitAny` — stays off by design: the dual-dialect Drizzle union + the
  `noUncheckedIndexedAccess` casts make `any` a sanctioned pattern (see
  CLAUDE.md). Not a ratchet target.

**Layer 1 doesn't catch:** anything runtime-specific. SQLite is the
only dialect actually exercised end-to-end (pg-smoke covers the
schema path but not the production drivers). Edge-runtime branches
(`isStatelessEdge`, `isCloudflareWorkers`) never fire.

## Layer 2 — `build-targets` (bundle validation)

`scripts/build-targets.ts` runs:

1. `vite build` once — the SPA bundle is identical across targets.
2. Three platform builds in parallel:
   - **Cloudflare:** `wrangler deploy --dry-run --outdir .tmp/cf-build`
     (offline, no API token; validates `wrangler.toml` + the worker
     entry bundles cleanly with all aliases).
   - **Vercel:** `bun scripts/build-vercel-output.ts` emits the
     Build Output API tree at `.vercel/output/`.
   - **Netlify:** `bun scripts/build-netlify-fn.ts` pre-bundles the
     function into `apps/web/netlify/functions/api.mjs`.

```bash
bun run build:targets
```

Warm run: ~6 seconds. Cold: ~15. Wired into:
- `lefthook.yml::pre-push` — maintainer pushes get the gate locally.
- `.github/workflows/test.yml::build-targets` — every PR.
- `.github/workflows/deploy.yml::build-targets` — gates production
  deploys (so a force-merged PR can't ship a broken bundle).

**Layer 2 doesn't catch:** runtime behavior. The bundle building
doesn't prove the bundle SERVES correctly. A regression that picks
the wrong adapter at runtime, or breaks the URL rewrite in
`vercel-fn-entry.ts`, slips through.

## Layer 3 — `runtime-smoke` (real HTTP)

The CI matrix in `.github/workflows/test.yml::runtime-smoke` boots
each runtime in-runner and exercises a shared smoke contract over
real HTTP. Matrix: `[bun, vercel, netlify, cloudflare, lambda, gcp,
azure, deno]` — eight runtimes. Cloudflare **is** covered: the slot boots
the real worker bundle under `wrangler dev --local` against
`wrangler.ci.toml`, a sibling of `wrangler.toml` with the `[ai]` binding
removed (the one binding that needs a real CF login). See the CF D1 note
under [What it catches](#what-it-catches) below.

### Files

```
apps/web/tests/smoke/
  contract.ts      shared scenario (works against any base URL):
                   /health → sign-up → sign-in → get-session →
                   /api/_cron/tick auth gate (opt-in per runtime)
  orchestrate.ts   per-runtime DB setup + server spawn + /health
                   poll + contract run + teardown
  serve-bundle.mjs Node http host for pre-bundled vercel / netlify
                   functions; sniffs { fetch } vs default-function
                   shape, adapts Node IncomingMessage ↔ Web Request
  run.ts           CLI entry; takes SMOKE_URL env (handy against
                   remote URLs too)
```

### Run locally

```bash
# Bun runtime (uses temp sqlite, no postgres needed):
SMOKE_RUNTIME=bun PORT=8787 bun apps/web/tests/smoke/orchestrate.ts

# Vercel / Netlify bundle (needs a real Postgres with pgvector):
DATABASE_URL=postgres://... SMOKE_RUNTIME=vercel \
  bun apps/web/tests/smoke/orchestrate.ts
```

CI provides Postgres via the `pgvector/pgvector:pg16` service
container. The Bun matrix slot explicitly clears `DATABASE_URL`
inside the spawned process so `context.ts` keeps picking sqlite
(otherwise the job-level env would override the sqlite path the
migrations just ran against).

### What it catches

- **Bundle import errors** — if a Node-targeted bundle imports a
  Bun-only API (`bun:sqlite`, `Bun.file`, etc.), the bundle fails
  to load and `serve-bundle.mjs` dies at startup. The orchestrator's
  `/health` poll times out and the matrix slot fails.
- **Runtime-conditional adapter selection** — `isStatelessEdge`,
  `isCloudflareWorkers` etc. fire on the real runtime; choosing the
  wrong DB driver or storage adapter shows up in the contract's
  /health check.
- **Cookie / auth round-trip** — better-auth's session cookie has
  to be set, returned, and resolved over real HTTP. SameSite,
  domain, and `getSetCookie()` shape regressions only appear here.
- **Cron secret gate** — vercel.ts accepts `Authorization: Bearer
  $CRON_SECRET` OR `x-cron-secret: $CRON_SECRET`; netlify.ts only
  accepts `x-cron-secret`. The contract's no-secret call expects
  401 on both — a regression that opens the gate publicly fails
  loudly.
- **CF D1 + worker entry** — `wrangler dev --local` boots the actual
  worker bundle against an in-process D1 (sqlite). The
  `cloudflare` matrix slot uses `wrangler.ci.toml`, a sibling of
  `wrangler.toml` with the `[ai]` binding removed (the only binding
  that requires a real CF login). The same `migrate-d1.ts` script
  that ships migrations to production applies them to the temp
  miniflare state dir first, so the route layer hits a real
  populated D1.

## Adding a new test

| When you're adding... | Put it in... |
|---|---|
| Business logic, route handler, service | `apps/web/tests/<feature>.test.ts` (Layer 1) |
| Schema change / new migration | covered by Layer 1's `pg-smoke` + `setup.ts::makeHarness` |
| New deploy target | new entry in `scripts/build-targets.ts` (Layer 2) |
| Runtime-specific behavior (cookie, cron, adapter) | new step in `apps/web/tests/smoke/contract.ts` (Layer 3) |

## CI gates

| Workflow | Jobs | Triggered by |
|---|---|---|
| `test.yml` | `test`, `build-targets`, `runtime-smoke (bun/vercel/netlify/cloudflare)` | every PR + push to `main` |

All three platforms deploy from `main` natively via their own git
integrations (Vercel, Netlify, and Cloudflare Workers Builds) — there
is no separate deploy workflow. `test.yml` running on `push: main` is
the post-merge tripwire, not a pre-deploy gate; platforms start
shipping as soon as the commit lands. The real gate is the pre-push
hook (lefthook) for the maintainer and the PR status checks for
contributors (where branch protection requires them).
