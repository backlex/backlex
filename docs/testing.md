---
title: Testing
description: Three-layer test pyramid that gates every change against business logic, build artifacts, and real-runtime behavior.
---

Backlex builds the same source tree into bundles for every deploy target —
Bun and Node self-host, Cloudflare Workers, Vercel, Netlify, and the serverless
clouds (see [Deployment](/docs/deployment)). The `build:targets` CI gate compiles the
Workers / Vercel / Netlify / Node bundles on every run. To keep that
multi-runtime promise honest, the test setup runs at three layers, each catching
what the layer above can't see.

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3 — runtime-smoke (CI matrix: 8 runtimes)             │
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

### The Postgres dialect (`*-pg.test.ts`, ~18 specs)

The pg specs run against **`pglite`** — a WASM Postgres that boots in-process,
with pgvector shipped in the same npm package. There is no Docker, no server,
and no connection string: the `DATABASE_URL` the harness writes
(`postgres://pglite-in-memory`) is a placeholder that exists only so
`buildContext` takes the pg branch, and the real client is injected directly.
So these run everywhere `bun test` runs, including a laptop on a plane.

**A harness that cannot boot FAILS the run.** It used to skip: each spec caught
the boot error, logged "skipping", and returned early from every test. bun has
no notion of "returned early" — such a test is reported as a **pass** — so a run
where the whole pg dialect went untested looked exactly like one where it all
worked. Fifty-one tests, zero coverage, green summary. Since nothing external
is required, a boot failure is a defect (a driver call, a migration pglite
cannot take, a dependency bump), and it has been one before: a positional
`drizzle(pg)` call silently ran every query against an empty database, and the
skip is why it survived.

One helper does this for every spec — `makeHarnessPgOrFail(tag)` in
`tests/setup-pg.ts` — and `tests/pg-specs-fail-loudly.test.ts` is the gate that
keeps the eighteenth copy from reintroducing a private `catch`. To skip the pg
dialect deliberately:

```bash
BACKLEX_PG_TESTS=optional bun test    # says "asserted NOTHING" on stderr
```

CI never sets it, so the escape hatch cannot be the accident.

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

~~The `@/` path alias isn't resolved under bun test~~ — **it is.** Render tests
still import the component under test by relative path (they sit outside
`src/`), but the component's own `@/` imports resolve fine: `ask-ai/index.tsx`
and `storage/index.tsx` both import `@/lib/api` and both render under the
harness. The note survived past its own fix and was steering new tests away
from pages it had no reason to.

**Known follow-up:** generated row types, to kill the snake_case/camelCase
drift a render test currently has to know about by hand.

**Where the coverage actually is not.** `admin/collections/` and
`admin/fields/` are 18,861 lines — about a quarter of the admin client — and
they are mounted straight from `app.tsx`, not from `admin/pages/`. A census of
"the busiest pages" walks `pages/` and misses them entirely, which is how the
five largest files in there had no test referencing them at all. Measured
across the routed admin: 30 of 42 pages, 53% of the lines, have no test. The
convention that a touched page gains a test is a convention — nothing enforces
it, and `admin-ui-conventions.test.ts`'s cases are all about chrome.

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
- `.github/workflows/test.yml::build` — every PR, and every push to
  `main` when a build-relevant path changed (the `changes` filter).

There is **no `deploy.yml`**. This page used to claim one gated
production deploys; it never existed, and believing it is how the
gap in "CI gates" below went unnoticed — the platforms deploy
themselves, from their own git integrations.

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
| `test.yml` | `test`, `changes`, `build`, `runtime-smoke (×8 runtimes)`, `deploy` | every PR + push to `main` |

All three platforms deploy from `main` natively via their own git
integrations (Vercel, Netlify, and Cloudflare Workers Builds), so the
push starts the deploy and this workflow at the same moment — neither
waiting for the other. That makes `test.yml` a **tripwire**: it says
what happened, which is a different job from stopping it.

### Making it an actual gate

**The fix cannot be "make the build wait".** Measured: the `test` job
takes ~16 minutes on `main`, and Cloudflare terminates a build at 20.
A build that waited for the suite would be killed before doing its own
work. So the trigger is inverted instead — the suite starts the build.

Two halves, and only one of them is automatic:

1. **`scripts/require-green-checks.ts`**, wired as the first thing in
   `bun run build` (the only hook the repo controls; Cloudflare's build
   and deploy commands live in its dashboard). It asks GitHub for the
   `test.yml` run of the exact commit being built and **refuses a
   commit whose run is already known red** — a re-run, a superseded
   build, a manual trigger on a stale commit. It is inert locally and
   in CI, and it does not block a run still in progress unless
   `PREDEPLOY_GATE_STRICT=1`.
2. **The `deploy` job in `test.yml`**, which calls Cloudflare's
   manual-build endpoint pinned to the commit, after every job that ran
   has succeeded. **Inert until three secrets exist** (`CF_API_TOKEN` —
   user-scoped, Workers Builds Configuration = Edit — plus
   `CF_ACCOUNT_ID` and `CF_BUILD_TRIGGER_UUID`), and it needs one
   dashboard change to be worth anything: turn the automatic branch
   trigger OFF for `main`, or it merely adds a second build alongside
   the first. Then set `PREDEPLOY_GATE_STRICT=1` in the build
   environment so anything reaching the builder by another route is
   refused.

Until step 2 is configured, the pre-push hook (lefthook) is still the
maintainer's real gate and PR status checks are the contributors'.
