---
title: Deployment
description: Ship the same source to Bun, Node, Deno, AWS Lambda, Google Cloud Functions, Azure Functions, Cloudflare Workers, Vercel, or Netlify.
---

Backlex runs the same source on nine runtimes — **Bun**, **Node**, and **Deno**
self-host, plus **AWS Lambda**, **Google Cloud Functions**, **Azure Functions**,
**Cloudflare Workers**, **Vercel**, **Netlify**, and **Deno Deploy**. The matrix
below compares the five managed / serverless targets; standalone **Node** and
**Deno** self-host, plus **AWS Lambda**, **Google Cloud Functions**, and **Azure
Functions**, get their own sections further down. Pick one based on the
constraints you need.

|                    | Bun (self-host)   | Cloudflare Workers   | Vercel Functions (Node 22, Build Output API) | Netlify Functions (Node 22) | Deno Deploy (managed)⁴ |
|--------------------|-------------------|----------------------|----------------------|------------------------------|------------------------|
| **Database**       | SQLite, libSQL/Turso, or PG | D1 or libSQL/Turso — **no Postgres**⁶ | PG via `DATABASE_DRIVER=neon-http` (recommended — HTTP avoids cold-start TCP handshake), or libSQL/Turso | PG via `DATABASE_DRIVER=neon-http` (recommended), or libSQL/Turso | PG via `neon-http` (auto-forced); libSQL/Turso too |
| **Storage**        | local fs / S3 / `Bun.S3Client` | R2 (S3 fallback) | S3 (`aws4fetch`) **required** — Lambda zip has no local fs | S3 (`aws4fetch`) **required** — Lambda zip has no local fs | S3 (`aws4fetch`) **required** — no fs |
| **Realtime**       | in-proc + SSE     | Durable Objects + WS | Ably signals¹ (or Upstash long-poll) | Ably signals¹ (or Upstash long-poll) | Ably signals¹ (or Upstash long-poll) |
| **SAML**           | yes               | yes (nodejs_compat)  | yes (Node 22 native crypto) | yes (Node 22 native crypto) | yes (Deno `node:crypto`) |
| **LDAP / SMTP**    | yes               | 503 (no raw TCP)     | yes (Node 22 has raw TCP) | yes (Node 22 has raw TCP) | no (no raw TCP) |
| **Sandbox**        | Bun worker        | QuickJS / remote HTTP | QuickJS / remote HTTP | QuickJS / remote HTTP | QuickJS-WASM / remote HTTP |
| **Image**          | `Bun.Image`       | CF Image Resize      | `sharp`²             | Netlify Image CDN³   | WASM `@cf-wasm/photon`⁴ |
| **Cron**           | setInterval       | wrangler triggers (or `/api/_cron/tick`⁵) | `.vercel/output/config.json` crons (emitted by `scripts/build-vercel-output.ts`; Vercel sends `Authorization: Bearer $CRON_SECRET` automatically) | scheduled function pings `/api/_cron/tick` with `x-cron-secret: $CRON_SECRET` | native `Deno.cron` (1-min idempotent tick) |
| **Cost**           | VPS               | $0–5/mo              | $0–20/mo             | $0–19/mo             | $0+ (free tier) |

¹ Realtime on these stateless targets has two paths, and `ABLY_API_KEY` is the one
that fits a free tier.

**Ably (recommended).** With `ABLY_API_KEY` set and no Upstash, row events ride the
**signal-only data plane**: the server publishes ID-only `{event, collection, id}`
signals to Ably, the browser connects to Ably directly, and the client reads the
changed rows back over the permission-filtered REST path. Delivery costs **zero
function invocations**. The same key also carries the admin's live-collaboration
channels. Trade-off: subscribers learn the ids and timing of changes, so the plane
is offered only to roles with an unconditional `read` grant (override with
`REALTIME_SIGNAL_SCOPE=all`). See `docs/realtime.md` § Signal-only data plane.

**Upstash Redis.** With `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`,
publish/subscribe fan out through a Redis stream and subscribe is a bounded
long-poll that closes and lets `EventSource` reconnect. This keeps full
server-side per-row filtering and `Last-Event-ID` replay, so it takes priority
when configured — but it holds a function invocation open per subscriber
(~130K invocations/month for one always-open tab, against a 125K free tier) and
burns ~3,600 Redis commands per editor-hour. Use it when you're already paying
for Upstash and want full-fidelity events.

With neither, realtime falls back to the in-process map (useless when instances
are stateless) — use Bun/Workers instead. Both paths verified live on Vercel and
Netlify.

² Image transforms on Vercel use `sharp`. The Vercel build stages sharp's native
`@img/*` closure into the function (`scripts/build-vercel-output.ts`); if the binary
can't load, the adapter degrades to passthrough (a clean 422). Set the S3 env so there
are files to transform.

³ Image transforms on Netlify use the native **Netlify Image CDN** (`/.netlify/images`)
rather than bundling sharp's fragile native addon — the analog of Cloudflare Image
Resizing on Workers. Needs `R2_PUBLIC_BASE` + a public-ACL file; the storage route
302-redirects to the CDN, and `netlify.toml`'s `[images] remote_images` (plus the
dynamic `.netlify/deploy/v1/config.json` from `build-netlify-fn.ts`) allowlists the R2
public origin. Verified live.

⁴ **Deno Deploy is experimental / best-effort** — see the
[Deno Deploy](#deno-deploy-managed) section for the deploy steps and gotchas.
`isDenoDeploy()` (set by `DENO_DEPLOYMENT_ID`) auto-forces HTTP-only drivers
(`neon-http`, Turso HTTP, `aws4fetch`) and bails the in-process realtime to
Upstash, exactly like Vercel/Netlify serverless. Image transforms run through the
`@cf-wasm/photon` WASM fallback (avif degrades to webp) because `sharp`'s native
addon doesn't load; **SMTP/LDAP need raw TCP and aren't available** — use an
HTTP email provider (resend/sendgrid/mailgun/ses). Verified live: `/health`, auth
sign-in, realtime, storage.

⁵ A normal Workers deploy uses `wrangler.toml::triggers.crons`, and the
`/api/_cron/tick` route stays closed because `CRON_SECRET` is unset. Set it only
if the platform running this bundle can't attach a cron trigger to the script —
notably **Workers for Platforms**, where a user Worker in a dispatch namespace
exports `scheduled()` but has no schedules resource to register a cron against,
so nothing ever calls it. On such an instance jobs, scheduled publish/unpublish,
auto-backups, CDC, cron flows and integration syncs never run, and nothing
reports a failure — the handler is simply never invoked. With `CRON_SECRET` set,
have the platform ping `/api/_cron/tick` with `x-cron-secret: $CRON_SECRET` (or
`Authorization: Bearer`); `cronTick` is idempotent and deduped by `lastTickAt`,
so at-least-once delivery is safe.

⁶ **Postgres is not supported on Cloudflare Workers**, including through
Hyperdrive. The Workers bundle ships without a Postgres driver on purpose:
`apps/web/vite.config.ts` aliases `postgres`, `@neondatabase/serverless` and
both `@backlex/db/pg` entrypoints to shims, which keeps every `pgTable`
definition and `drizzle-orm/pg-core` out of the eager cold-start graph —
`@backlex/db/pg` is statically imported across ~80 files, so this is not a flag
you can flip, it is a different bundle. Binding Hyperdrive would give you a
Worker that boots and then fails on its first query, so `context.ts` refuses the
combination up front with a message naming the alternatives.

**What to use instead.** For a networked database on Workers, set `LIBSQL_URL`
(+ `LIBSQL_AUTH_TOKEN`) for Turso/libSQL — it is fetch-based, edge-safe and not
shimmed. For D1, bind `D1` as usual. If you specifically need Postgres, deploy
the Bun, Node, Vercel or Netlify target, all of which support it. See
[Database providers](/database-providers/).

## Bun (self-host)

```bash
APP_URL=https://your.app \
DATABASE_URL=postgres://user:pass@host:5432/backlex \
AUTH_SECRET=$(openssl rand -hex 32) \
bun run --cwd apps/web dev:bun
```

For a managed process: systemd unit, Docker, or `pm2`. The Bun scheduler
boots inside `apps/web/src/server/entries/bun.ts`; cron functions tick
every 30 seconds.

## Node.js (self-host, no Bun)

The same app runs on plain Node ≥ 20 via `@hono/node-server`. Build a
self-contained bundle once (Bun does the bundling — `bun:sqlite` aliased to a
shim, `sharp` left external), then run it with `node`:

```bash
bun run build:node                 # → apps/web/dist/node/server.mjs

APP_URL=https://your.app \
DATABASE_URL=postgres://user:pass@host:5432/backlex \
AUTH_SECRET=$(openssl rand -hex 32) \
PORT=8787 \
node apps/web/dist/node/server.mjs   # or: bun run start:node
```

Node has no `bun:sqlite`, so use **Postgres** (`DATABASE_URL`); for SQLite use a
libSQL/Turso URL instead. Everything else auto-selects for Node in
`buildContext`: `sharp` for image transforms, `node:fs`/S3 storage, QuickJS-WASM
(or remote-http) sandbox, in-process SSE realtime (or Upstash for multi-instance),
SMTP/`nodemailer` or HTTP email, and the same `setInterval` cron scheduler. Entry:
`apps/web/src/server/entries/node.ts`. `bun run build:targets` builds it alongside
the CF/Vercel/Netlify targets.

## AWS Lambda (serverless)

The same app runs on **AWS Lambda** (Node 22.x) behind Hono's `aws-lambda`
adapter — a single function fronts the whole `/api/*` surface. It works with
**API Gateway** (REST v1 + HTTP API v2), an **ALB** target group, or a **Lambda
Function URL**. Build the single-file bundle (Bun does the bundling — same shims
as the Node target):

```bash
bun run build:lambda               # → apps/web/dist/lambda/ (index.mjs + client/)

# Zip dist/lambda/ and upload, or wire it into SAM/CDK/Terraform.
# Handler string:
#   index.handler        — buffered: API Gateway / ALB / default Function URL
#   index.streamHandler  — streaming: Function URL with InvokeMode RESPONSE_STREAM
```

**Admin panel:** the build copies `dist/client` into `dist/lambda/client`, and the
function serves the admin SPA itself (`mountSpa`) — so the panel is reachable at
`/` straight from the Lambda, not just `/api`. Every static asset is then a
function invocation; for production, front the function with **CloudFront** over
an S3 copy of `dist/client` (SPA + assets cached at the edge) and route only
`/api/*` + `/health` to API Gateway → Lambda. That's the same split Vercel/Netlify
do automatically.

Two handlers are exported from `apps/web/src/server/entries/lambda.ts`:

- **`handler`** (buffered) — what most setups want. API Gateway / ALB / a default
  Function URL.
- **`streamHandler`** (response-streaming via `awslambda.streamifyResponse`) —
  **only** behind a Lambda Function URL with `InvokeMode: RESPONSE_STREAM`, where
  it lets SSE / long bodies flush incrementally instead of buffering. It's
  `undefined` outside a streaming runtime (the `awslambda` global is only injected
  there), so importing the bundle never crashes a buffered deploy.

Runtime constraints (same shape as the Vercel/Netlify Node functions):

- **DB** — no `bun:sqlite`; use **Postgres** (`DATABASE_URL`). Lambda is short-
  lived, so `DATABASE_DRIVER=neon-http` (or RDS Proxy in front of postgres-js)
  avoids a TCP handshake on every cold start. Node 22 has real TCP, so plain
  postgres-js works too. libSQL/Turso also works.
- **Storage** — the function fs is ephemeral; set `S3_BUCKET` +
  `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (native S3 via `aws4fetch`).
- **Realtime** — module-level pub/sub doesn't survive between invocations; set
  `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. The buffered `handler`
  can't stream SSE — use `streamHandler` behind a streaming Function URL for live
  SSE.
- **Image** — `sharp` runs when its native addon is present in the deployment
  package (ship the `linux-x64`/`linux-arm64` build in the zip or a layer);
  otherwise transforms degrade to passthrough.
- **SAML / LDAP / SMTP** — all work (Node 22 raw `node:net`/`tls`).
- **Cron** — `setInterval` schedulers don't run on Lambda; drive an **EventBridge
  Scheduler** rule that calls `/api/_cron/tick` with `x-cron-secret: $CRON_SECRET`
  (or `Authorization: Bearer $CRON_SECRET`). The shared `cronTick` is idempotent
  + deduped by `lastTickAt`, so at-least-once delivery is safe; the route 401s
  without the secret.

`bun run build:targets` builds the Lambda bundle alongside the other targets.

## Google Cloud Functions (2nd gen)

The same app runs on **Google Cloud Functions (2nd gen)** — which is Cloud Run
under the hood. GCF uses the **Functions Framework**, whose `http()` registers
an Express-style `(req, res)` handler; Hono's `getRequestListener(app.fetch)` is
exactly that listener, so one registered function fronts `/api/*` with no event
mapping. Build the deployable folder, then `gcloud functions deploy`:

```bash
bun run build:gcp                  # → apps/web/dist/gcp/ (index.mjs + package.json + client/)

gcloud functions deploy backlex \
  --gen2 --runtime=nodejs22 --entry-point=api --trigger-http \
  --source=apps/web/dist/gcp --allow-unauthenticated \
  --set-env-vars=APP_URL=https://your.app,DATABASE_URL=...,AUTH_SECRET=...
```

**Admin panel:** the build copies `dist/client` into `dist/gcp/client` and the
function serves the admin SPA itself (`mountSpa`), so the panel is reachable at
`/`. For production, front it with **Cloud CDN** (external HTTPS Load Balancer:
a backend bucket for `dist/client` + a serverless NEG for `/api/*`) so static
assets are edge-cached instead of invoking the function.

Entry: `apps/web/src/server/entries/gcp.ts` (registered as **`api`** —
`--entry-point=api`). The build keeps `@google-cloud/functions-framework` +
`sharp` external and declares them in a generated `package.json` so the GCF
buildpack installs them on the platform. Because GCF 2nd gen is long-lived
Cloud Run, **SSE works natively** (no `awslambda`-streaming dance). Other
constraints match the Vercel/Netlify Node functions:

- **DB** — Postgres (`DATABASE_URL`; `neon-http` avoids a cold-start TCP
  handshake), or libSQL/Turso. No `bun:sqlite`.
- **Storage** — set `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`
  (points at GCS's S3-compatible XML API or any S3); the container fs is ephemeral.
- **Realtime** — set `UPSTASH_REDIS_REST_*` (instances scale to zero / fan out).
- **SAML / LDAP / SMTP** — all work (Node 22 raw TCP).
- **Cron** — a **Cloud Scheduler** job hits `/api/_cron/tick` with
  `x-cron-secret: $CRON_SECRET` (idempotent, deduped; 401s without the secret).

## Azure Functions (v4)

The same app runs on **Azure Functions** (v4 Node programming model). Azure has
no official Hono adapter, so a small shim in the entry bridges Azure's
`HttpRequest`/`HttpResponseInit` (both Fetch-shaped) to `app.fetch`. Build the
deployable folder (with a generated `host.json` + `package.json`), then publish
with the Azure Functions Core Tools:

```bash
bun run build:azure                # → apps/web/dist/azure/ (index.mjs + host.json + package.json + client/)

cd apps/web/dist/azure
func azure functionapp publish <APP_NAME>
# set app settings (env): APP_URL, DATABASE_URL, AUTH_SECRET, S3_*, UPSTASH_* …
```

Entry: `apps/web/src/server/entries/azure.ts`. It registers two functions:

- **`api`** — an HTTP catch-all (`route: "{*path}"`). The generated `host.json`
  sets `extensions.http.routePrefix: ""` and the build copies `dist/client` into
  `dist/azure/client` + the entry calls `mountSpa`, so this one function serves
  the **admin SPA** at `/` (and `/health`, `/docs`) — not just the default `/api`
  prefix. For edge-cached assets in production, front it with a CDN or use
  **Azure Static Web Apps** (static SPA + integrated Functions API).
- **`cron`** — a native **Timer trigger** (every minute) that calls the shared
  idempotent `cronTick` directly. No HTTP cron route or shared secret needed:
  Timer triggers aren't publicly reachable.

The build keeps `@azure/functions` + `sharp` external (the runtime provides the
former; `app.http()`/`app.timer()` must register on its instance). Constraints
match the Vercel/Netlify Node functions:

- **DB** — Postgres (`DATABASE_URL`; `neon-http` recommended), or libSQL/Turso.
- **Storage** — set `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`
  (works against Azure Blob's S3-compatible endpoints or any S3).
- **Realtime** — set `UPSTASH_REDIS_REST_*`. The shim buffers responses, so rely
  on the Upstash long-poll transport rather than streamed SSE.
- **SAML / LDAP / SMTP** — all work (Node 22 raw TCP).

`bun run build:targets` builds the GCP and Azure bundles alongside the other
targets.

## Deno (self-host, experimental)

The same source also runs on **Deno 2** via its npm compatibility — no bundle
step; Deno runs the TypeScript source directly. Install deps with Bun first (for
`node_modules`), then start it:

```bash
bun install                          # provides node_modules for Deno's npm compat

DATABASE_URL=postgres://user:pass@host:5432/backlex \
AUTH_SECRET=$(openssl rand -hex 32) \
PORT=8787 \
deno task start:deno                 # → deno run -A apps/web/src/server/entries/deno.ts
```

Config lives in `deno.json` (`nodeModulesDir: "manual"` + a `bun:sqlite` → shim
import map). Verified live (`/health` + the realtime route boot against Neon
Postgres). Caveats:

- **SQLite** works via libSQL — set `LIBSQL_URL` (a `file:`/`:memory:` path or a
  Turso `libsql://` URL); no `bun:sqlite`. Postgres via `DATABASE_URL` also works.
- **Image transforms** run through a **WASM fallback** (`@cf-wasm/photon`) since
  `sharp`'s native addon doesn't load on Deno — resize + webp/jpeg/png all work
  (avif falls back to webp). Verified live. Realtime, sandbox (QuickJS-WASM),
  storage, auth, SSO, and email work too.

This is best-effort: Deno's stricter ESM means an occasional dependency needs a
cross-runtime tweak (JSON import attributes, CJS-interop default imports). One
known rough edge: the cron `scheduled_tasks` claim logs a Date-binding interop
error on Deno (non-fatal). Prefer Bun or Node for production self-host.

## Deno Deploy (managed)

The same source also runs on **Deno Deploy** (the managed platform). Because the
managed builder runs on Deno's npm compat and ships **no Bun**, the dance is a
little different from a plain `deno task start:deno`. Verified live at
`https://backlex-prod.kinyasfurkan.deno.net` (DB via Neon `neon-http`, auth
sign-in, realtime, storage). Deno Deploy is an HTTP-only V8-isolate edge, so
`isDenoDeploy()` (set by `DENO_DEPLOYMENT_ID`) auto-forces `neon-http` for the DB
and bails the in-process SSE realtime to Upstash — same path as Vercel/Netlify.

Create the app non-interactively with the `deno deploy` CLI (`deno` ≥ 2.8;
`ddo_…` deploy token via `--token` or `DENO_DEPLOY_TOKEN`):

```bash
deno deploy create \
  --org <org-slug> --app backlex \
  --source local --do-not-use-detected-build-config --app-directory . \
  --install-command 'npm install -g bun --prefix "$HOME/.local" && "$HOME/.local/bin/bun" install --ignore-scripts' \
  --build-command 'export PATH="$HOME/.local/bin:$PATH" && bun run build' \
  --entrypoint apps/web/src/server/entries/deno.ts \
  --runtime-mode dynamic --region eu \
  --build-timeout 5 --build-memory-limit 3072
```

The `--build-command` runs `vite build` so the admin SPA (`apps/web/dist/client`)
ships inside the deploy artifact — the Deno entry serves it for non-API routes
(`mountSpa` in `entries/deno.ts`), so the deployed URL shows the full admin UI,
not just the API. `dist/` is git-ignored and `--source local` honours
`.gitignore`, so the SPA *must* be built on the builder; a local `dist/client`
is never uploaded. Building on the builder works because the SPA bundler is
**rolldown** (its native binding is an optional dependency, not a postinstall),
so `--ignore-scripts` doesn't starve it. (If you only need the API, drop
`--build-command`; `/` then 404s and the admin UI lives on the Workers deploy.)

Four gotchas the commands above already work around — each one fails the build
during the `installing`/`building` step otherwise:

- **No Bun on the builder.** Install it first. A plain `npm install -g bun` hits
  `EACCES` (the builder runs as a non-root `/home/app` user and can't write the
  global `/usr/lib/node_modules` prefix), so install into a user-writable
  `--prefix "$HOME/.local"` and call the binary by its full path. Installing Bun
  globally (not as a local dep) also keeps npm away from the repo's
  `workspace:*` deps, which npm can't resolve.
- **`--ignore-scripts` is mandatory.** Bun runs lifecycle scripts for packages on
  its built-in trusted-deps allow-list (which includes `msw`, a devDependency).
  `msw`'s postinstall shells out to `node`, which the builder maps to `deno eval`,
  and it dies on an unknown `-A` flag. We don't need any postinstall at runtime
  (`sharp`/`better-sqlite3`/`esbuild` native steps are unused on Deno), so skip
  them all.
- **`PATH` in the build command.** The root `build` script shells out to a bare
  `bun` (`bun run --cwd apps/web build`), but Bun was installed into
  `$HOME/.local`, which isn't on the builder's `PATH`. Prefix the build command
  with `export PATH="$HOME/.local/bin:$PATH"` so the nested `bun` resolves
  (otherwise: `bun: command not found`, exit 127).
- **Free-plan build limits** cap `--build-timeout` at 5 (minutes) and
  `--build-memory-limit` at 3072 (MiB). The numbers above are the max.

Then set secrets and push a deploy (the first `create` registers the build
config; `deno deploy` re-runs it against the latest local source):

```bash
deno deploy env add --secret AUTH_SECRET "$(openssl rand -hex 32)" --org <org> --app backlex
deno deploy env add --secret DATABASE_URL "postgres://…"            --org <org> --app backlex
deno deploy env add DATABASE_DRIVER neon-http                        --org <org> --app backlex
# …S3_* (R2), UPSTASH_REDIS_REST_* (realtime), APP_URL, AUTH_PLUGINS as needed

deno deploy --org <org> --app backlex --prod
```

Build config is only settable at `create` time (the CLI has no build-config
update). To change the install command / limits, create a new app. The
`--source local` flow uploads your working tree — it is not git-linked, so it
won't auto-deploy on push; for that, connect the repo at app.deno.com instead and
use the same install command + entrypoint + env. Build logs aren't streamed
inline by the CLI — watch them in the dashboard build view.

## Cloudflare Workers

`apps/web/wrangler.toml` covers the bindings. First-time setup:

```bash
cd apps/web

wrangler d1 create backlex          # paste id into wrangler.toml
wrangler r2 bucket create backlex-files
wrangler vectorize create backlex-embeddings --dimensions=1536 --metric=cosine

wrangler secret put AUTH_SECRET
wrangler secret put RESEND_API_KEY        # optional — email provider key
                                          # (or SENDGRID_API_KEY / MAILGUN_API_KEY / SES_*)
wrangler secret put OAUTH_GOOGLE_CLIENT_ID  # optional
# ...
# EMAIL_FROM (and EMAIL_PROVIDER) aren't secrets — put them in wrangler.toml [vars].
# smtp is not available on Workers; use an HTTP provider here.

wrangler d1 migrations apply backlex --remote
wrangler deploy
```

### Git integration (recommended)

Connect the GitHub repo from the Cloudflare dashboard and let every push to
`main` auto-deploy. No GitHub Actions workflow is needed.

1. **dash.cloudflare.com → Workers & Pages → backlex-admin → Settings → Builds**
   → **Connect** → pick the Backlex repo.
2. **Production branch:** `main`.
3. **Build command:** `bun run db:migrate:d1:remote && bun run build`
   (the migration runs first so deploy never fronts a schema mismatch; the
   build container's `wrangler` is auto-authenticated, no token needed).
4. **Deploy command:** `cd apps/web && bunx wrangler deploy` — the
   `cd` is mandatory. wrangler 4 detects Bun workspaces and refuses
   to run from repo root with `"application detection logic has been
   run in the root of a workspace"`. `apps/web/` is where
   `wrangler.toml` lives and where the Vite build emits
   `dist/backlex_api/` + `dist/client/`.
5. **Root directory:** leave at repo root (`/`).
6. **Build environment variables** — the build container needs the same
   `wrangler.toml` bindings as production. Secrets stay on the Worker
   (`wrangler secret put …`); only build-time vars belong here.
7. **Deploy.** Every push to `main` ships to Production; non-production
   branches get preview URLs automatically.

PR test gating still runs in GitHub Actions (`.github/workflows/test.yml`)
— lint + typecheck + `bun test` + `bun run build:targets` exercise all four
runtimes (Bun / CF / Vercel / Netlify) on every PR and push to `main`.

### remote-http sandbox (optional, DB-aware functions on edge)

QuickJS-WASM runs functions in-isolate everywhere but is sync-only with no
`ctx.*` host I/O. For DB/fetch/email-aware functions on an edge runtime, run
the out-of-isolate executor (`apps/web/templates/fn-exec-server`) somewhere
`eval` / `new Function` are allowed — Fly.io, Railway, Render, a plain VM,
Cloudflare Containers:

```bash
bun run apps/web/templates/fn-exec-server/index.ts   # listens on :8790
```

Then point the Worker at it:

```bash
wrangler secret put FUNCTIONS_EXEC_URL  # https://your-exec-host (base URL, no /run)
wrangler secret put SANDBOX_RPC_TOKEN   # generate with `openssl rand -hex 32` (same on both)
wrangler secret put SELF_URL            # https://api.your.app
wrangler deploy
```

The selector falls back to QuickJS when `FUNCTIONS_EXEC_URL` is unset, so
Workers users still get a sandbox — sync only.

### Worker template artifact

`.github/workflows/publish-worker-template.yml` packages the same
`apps/web` CF build that ships to `backlex-admin.kinyasfurkan.workers.dev`
into a downloadable tarball, so a downstream provisioner (the private
`backlex-cloud` repo) can fetch a pre-built bundle and `wrangler deploy`
it into a fresh customer account — D1 + R2 + Worker in one shot — without
re-cloning + re-building this repo.

**Triggers**

- Push a tag of the form `worker-v<semver>` (e.g. `worker-v0.1.0`) →
  strict lint + typecheck + `bun test` + build, then the tarball is
  attached to a GitHub Release named after the tag. Downstream consumers
  pin to a specific tag.
- `workflow_dispatch` (with required `version` input) → same gates, but
  the tarball is uploaded as a workflow artifact
  (`worker-template-dryrun`, 14-day retention) instead of a Release
  asset. Use this to confirm the bundle assembles before cutting an
  intentional `worker-v*` tag.

**Tarball contents** (`backlex-app-worker-v<X.Y.Z>.tar.gz`):

```
backlex-app-worker-v<X.Y.Z>/
├── worker/
│   ├── index.js                       # bundled Hono worker entry (ES module)
│   └── assets/**                      # vendor chunks + per-migration SQL chunks
├── client/                            # SPA static assets (apps/web/dist/client/**)
├── migrations/
│   ├── sqlite/*.sql                   # one file per packages/db/drizzle/sqlite/* migration
│   └── manifest.json                  # ordered list + sha256 + bytes per migration
├── wrangler.template.toml             # bindings declaration with placeholders
└── meta.json                          # version, gitSha, builtAt, bun/node versions
```

`wrangler.template.toml` carries four placeholders the provisioner
substitutes per customer before `wrangler deploy`:

- `__D1_DATABASE_ID__` — `id` of the newly-created D1 database.
- `__R2_BUCKET_NAME__` — name of the newly-created R2 bucket.
- `__APP_URL__` — customer-facing Worker URL.
- `__R2_PUBLIC_BASE__` — `pub-*.r2.dev` origin (or custom domain).

`AUTH_SECRET`, `OPENAI_API_KEY`, `RESEND_API_KEY`, etc. stay as Worker
secrets (`wrangler secret put …`) — they are never inlined in the
template. The `.dev.vars*` files and any maintainer-account IDs from
`apps/web/wrangler.toml` are stripped during assembly; the workflow
also never reads any GitHub secret beyond the auto-injected
`GITHUB_TOKEN` (so a fork can run it safely).

**Local dry-run**

```bash
bun run scripts/build-worker-template.ts --version 0.1.0
# → ./dist-worker-template/backlex-app-worker-v0.1.0.tar.gz

# Skip the SPA build if you've just run `bun run build` yourself:
bun run scripts/build-worker-template.ts --version 0.1.0 --no-build
```

## Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/backlex/backlex&env=APP_URL,AUTH_SECRET,DATABASE_URL,DATABASE_DRIVER,S3_BUCKET,S3_ACCESS_KEY_ID,S3_SECRET_ACCESS_KEY,CRON_SECRET&envDescription=Backlex%20runtime%20secrets%20(Postgres%2C%20S3%2C%20auth)&envLink=https://github.com/backlex/backlex/blob/main/docs/deployment.md)

The one-click button clones the repo and prompts for the env vars below.
For an existing repo, use the Git integration further down instead.

`vercel.ts` at the repo root configures the install/build commands;
everything else (routing, function registration, crons) is emitted by
`scripts/build-vercel-output.ts` into `.vercel/output/` using the
**Vercel Build Output API**. The pipeline ships:

- A single Node serverless function under Fluid Compute that handles
  every `/api/*` path (pre-bundled by Bun, runtime `nodejs22.x`, 60s
  `maxDuration`).
- The admin SPA as static assets.
- A cron entry that pings `/api/_cron/tick` once per day at 00:00 UTC
  (Hobby plan only allows daily; edit `scripts/build-vercel-output.ts`'s
  `config.json` block + upgrade to Pro for finer intervals).

### Why Build Output API (and not zero-config)?

Three things ruled out the simpler paths:

1. **Vercel's function bundler doesn't transpile `.ts` workspace
   packages.** Our `packages/{core,auth,db}` export `.ts` source via
   `package.json::exports`; the bundler ships them as broken symlinks
   and Lambda module evaluation crashes at load.
2. **Vercel's Node runtime keys off the handler shape.** A bare
   `export default async function (req)` is read as the legacy Express
   signature `(IncomingMessage, ServerResponse)` — Hono can't consume
   that. The Web Standard `export default { fetch(req): Response }`
   shape opts into the modern path (Hono's `app.fetch` matches it).
3. **Zero-config function discovery runs before `buildCommand`.** Any
   `api/*.mjs` our build script writes is invisible to that scan, and
   declaring it via `vercel.ts::functions` fails the deploy in the same
   pre-build step (`"pattern doesn't match any Serverless Functions
   inside the api directory"`).

The Build Output API takes precedence over all three: when
`.vercel/output/` exists after the build step, Vercel uses it verbatim
and skips its own discovery + validation entirely.

### How the build works

The build command chains the Vite SPA build with the output script:
`DEPLOY_TARGET=vercel bun run --cwd apps/web build && bun
scripts/build-vercel-output.ts`. The output script:

1. Pre-bundles `apps/web/src/server/entries/vercel-fn-entry.ts` with
   `Bun.build()` into
   `.vercel/output/functions/api/index.func/index.mjs`. The bundle
   inlines every workspace and npm dep (because Vercel's nft tracer
   can't follow Bun's `node_modules/.bun` monorepo store) and aliases
   `bun:sqlite` to its throwing shim (Node ESM can't parse the `bun:`
   specifier).
2. Writes the matching `.vc-config.json` (`nodejs22.x` runtime, `fetch`
   handler, 60s `maxDuration`).
3. Copies `apps/web/dist/client/` into `.vercel/output/static/`.
4. Writes `.vercel/output/config.json` (v3 schema) with the routing —
   a rewrite that funnels every `/api/(.*)` request into the single
   function as `/api/index?__path=$1`, then a `handle: "filesystem"`
   pass, then an SPA fallback — and the cron entry.

The handler at `vercel-fn-entry.ts` reads `__path` from the rewritten
URL's query string and rebuilds `request.url` so Hono routes the
original `/api/auth/get-session` etc. instead of the literal
`/api/index`.

### Git integration (recommended)

Connect the GitHub repo from the Vercel dashboard and let every push to
`main` auto-deploy. No GitHub Actions workflow is needed.

1. **vercel.com → Add New → Project** → pick the Backlex repo.
2. **Framework Preset:** `Other`. `vercel.ts` overrides install/build,
   and the Build Output API takes over from there — the preset only
   affects defaults that get overridden anyway.
3. **Root Directory:** leave at repo root (`/`). Do *not* point it at
   `apps/web`; the build command already runs Vite inside the workspace.
4. **Environment Variables** — set these on Production (and ideally
   Preview too). Minimum:
   - `APP_URL` — `https://your-project.vercel.app` (or the custom domain)
   - `AUTH_SECRET` — `openssl rand -hex 32`
   - `DATABASE_URL` — Postgres connection string (Neon recommended)
   - `DATABASE_DRIVER=neon-http` — recommended on serverless Lambdas;
     HTTP avoids the TCP handshake cost per cold start
   - `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ optional
     `S3_ENDPOINT`, `S3_REGION`) — Lambda zip has no local fs
   - `CRON_SECRET` — `openssl rand -hex 32`. Vercel automatically attaches
     `Authorization: Bearer $CRON_SECRET` to cron requests; the route also
     accepts `x-cron-secret` for manual callers
   - Optional: `EMAIL_PROVIDER`+`EMAIL_FROM`+provider creds,
     `OAUTH_*_CLIENT_ID/SECRET`, `AUTH_PLUGINS`, etc. — see the table below
5. **Deploy.** Every push to `main` ships to Production; every PR gets a
   Preview URL. The first request runs DB migrations against
   `DATABASE_URL` automatically.

### CLI alternative

```bash
vercel link
vercel env add DATABASE_URL
vercel env add DATABASE_DRIVER  # neon-http
vercel env add AUTH_SECRET
vercel deploy --prod
```

### Database driver on Vercel

Node 22 Lambdas expose `node:net`/`node:tls`, so plain `postgres-js`
works — but every cold start pays the TCP handshake. `neon-http` over
`@neondatabase/serverless` skips that and is the recommended path. Set
`DATABASE_DRIVER=neon-http`; the Vercel context honors it.

`Vercel Postgres` (legacy product name, now a Neon-managed integration
inside the Vercel dashboard) uses the same Neon driver — point
`DATABASE_URL` at it and the configuration is identical.

### Storage on Vercel

Lambda zips have no writable filesystem; set the S3 env vars and the
storage adapter switches to the S3 path automatically. Works with AWS
S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi —
anything that speaks the S3 API.

```bash
S3_BUCKET=backlex
S3_REGION=auto                                    # `auto` for R2; AWS region for S3
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # blank for AWS S3
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

Selection priority in `buildContext`:

1. `R2` binding (Cloudflare Workers) — fastest path on the edge.
2. `S3_BUCKET` set — `Bun.S3Client` when running on Bun, else
   `aws4fetch` (works in any runtime with WHATWG `fetch`).
3. otherwise — local `fsStorage` (Bun self-host dev only).

Pre-signed URLs are exposed via the `signedUrl(key, ttlSeconds)` adapter
method (e.g. for direct browser uploads / public CDN links).

### Runtime caveats

Vercel Functions run on Node 22, so the Bun-self-host surface is
mostly available — SAML, LDAP, SMTP all load (full
`node:crypto`/`node:net`/`node:tls`). Two exceptions:

- **Realtime** works via Upstash Redis: set `UPSTASH_REDIS_REST_URL` +
  `UPSTASH_REDIS_REST_TOKEN` and publish/subscribe fan out through a Redis
  stream per channel (the in-process `Map` doesn't survive a stateless Lambda).
  The subscribe endpoint is a **bounded long-poll** — it delivers a batch then
  closes so the function returns quickly (per Vercel/Netlify guidance: functions
  shouldn't hold connections), and the browser's `EventSource` auto-reconnects
  with `Last-Event-ID` to resume. Without the Upstash vars realtime falls back
  to the in-process map, which is impractical on a Lambda — use Cloudflare
  Workers (Durable Object) or Bun self-host instead.
- **`bun:sqlite`** is aliased to a throwing shim. Always set
  `DATABASE_DRIVER=neon-http` (or any non-sqlite driver) so the
  sqlite code path never loads.

### Image transforms on Workers

`GET /api/storage/:key?width=…&format=…` runs through Cloudflare Image
Resizing when:

1. `env.R2_PUBLIC_BASE` is set to a stable public origin for the bucket
   (r2.dev URL or a custom domain bound via `wrangler r2 bucket domain
   add`), AND
2. the file's ACL is `public`.

Enable the r2.dev origin once per bucket:

```bash
bunx wrangler r2 bucket dev-url enable backlex-files
bunx wrangler r2 bucket dev-url get backlex-files
# → Public URL: https://pub-<hash>.r2.dev
```

Then set `R2_PUBLIC_BASE = "https://pub-<hash>.r2.dev"` under `[vars]`
in `wrangler.toml` and redeploy. Without it, transform requests on
Workers return `422 VALIDATION` (no silent passthrough). Bun deployments
transform in-process via `Bun.Image` and don't need this var.

Heads-up: enabling the r2.dev URL makes *every* object in that bucket
readable by anyone who knows the key path — see `docs/storage.md`
"Security tradeoffs" for the mitigations.

## Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/backlex/backlex)

The one-click button clones the repo and runs the `netlify.toml` build.
Set the env vars from the Git-integration steps below before the first
request — without `DATABASE_URL` + `DATABASE_DRIVER=neon-http` the
function 500s on boot. For an existing repo, use the Git integration.

`netlify.toml` at the repo root deploys the admin SPA + a Node 22
serverless function for `/api/*` + a scheduled function for cron.

- API function source: `apps/web/src/server/entries/netlify-fn-entry.ts`
  (a thin Web Standard `(req) => app.fetch(req)` shim).
- Scheduled function source: `apps/web/netlify/functions/cron.ts`.
- Both use Netlify Functions **v2** (Web Standard `export default`).
  Mixing v1 (`export const handler`) with v2 in the same `functions/`
  directory makes the runtime fall back to v1 for the whole directory —
  keep new functions v2.

### Why pre-bundle?

The API function is pre-bundled by `scripts/build-netlify-fn.ts`
during the build command, **not** by Netlify's nft bundler. Two
incompatibilities forced this:

1. Netlify's bundler doesn't transpile TypeScript, and our workspace
   packages (`packages/{core,auth,db}`) export `.ts` source via their
   `package.json` `exports` field. The bundler ships them as symlinks
   to a `packages/` directory that isn't in the function zip, so
   Lambda module evaluation crashes at load time.
2. Even after working around (1), Netlify's nft tracer doesn't follow
   imports through Bun's monorepo `node_modules/.bun` store, so npm
   deps like `postgres` (imported transitively by `drizzle-orm/postgres-js`)
   end up missing from the zip.

The pre-bundle uses `Bun.build()` with a resolve plugin that aliases
`bun:sqlite` to `apps/web/src/server/shims/bun-sqlite-shim.ts` (Bun
specifier the Node ESM loader can't parse otherwise). The output is
a single self-contained `apps/web/netlify/functions/api.mjs` that
Netlify's bundler just zips. The pre-bundled artifact is gitignored —
build runs it fresh every deploy.

### Git integration (recommended)

1. **app.netlify.com → Add new site → Import an existing project** → pick
   the Backlex repo.
2. **Base directory:** leave empty (repo root). The `netlify.toml` already
   sets `base = ""`.
3. **Build command, Publish directory:** leave empty too — `netlify.toml`
   overrides both. The build command chains the Vite build with the
   pre-bundle script: `DEPLOY_TARGET=netlify bun install --frozen-lockfile
   && DEPLOY_TARGET=netlify bun run --cwd apps/web build && bun
   scripts/build-netlify-fn.ts`.
4. **Bun runtime:** `BUN_VERSION` is pinned to `1.3.14` in
   `[build.environment]`. Override per-site if you need a newer version.
5. **Environment Variables** (Site configuration → Environment variables):
   - `APP_URL` — `https://your-site.netlify.app` (or custom domain)
   - `AUTH_SECRET`, `DATABASE_URL`, `DATABASE_DRIVER=neon-http`,
     `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (+
     optional `S3_ENDPOINT`, `S3_REGION`) — same as Vercel
   - `CRON_SECRET` — the scheduled function reads this and attaches
     `x-cron-secret` when pinging `/api/_cron/tick`. Without it the cron
     function 500s loudly instead of silently dropping ticks
   - Optional providers — same as Vercel
6. **Deploy.** Every push to `main` ships to Production; every PR gets a
   Deploy Preview.

### CLI alternative

The Netlify CLI's monorepo prompt asks which workspace you're targeting;
pass `--filter @backlex/web` to keep it non-interactive:

```bash
netlify env:set DATABASE_URL postgres://... --filter @backlex/web
netlify env:set AUTH_SECRET $(openssl rand -hex 32) --filter @backlex/web
netlify deploy --build --prod --filter @backlex/web
```

For a brand-new site, `netlify api createSiteInTeam` plus a manual
"Link site to Git" in the dashboard avoids the interactive flow
entirely (you need the GitHub OAuth + deploy key only Netlify's
dashboard can provision).

### Runtime caveats

Netlify Functions run on Node 22, so the Bun-self-host surface is
mostly available — SAML, LDAP, SMTP, samlify all load (full
`node:crypto`/`node:net`/`node:tls`). Two exceptions:

- **Realtime** works via Upstash Redis: set `UPSTASH_REDIS_REST_URL` +
  `UPSTASH_REDIS_REST_TOKEN` and publish/subscribe fan out through a Redis
  stream per channel (the in-process `Map` doesn't survive a stateless Lambda).
  The subscribe endpoint is a **bounded long-poll** — it delivers a batch then
  closes so the function returns quickly (per Vercel/Netlify guidance: functions
  shouldn't hold connections), and the browser's `EventSource` auto-reconnects
  with `Last-Event-ID` to resume. Without the Upstash vars realtime falls back
  to the in-process map, which is impractical on a Lambda — use Cloudflare
  Workers (Durable Object) or Bun self-host instead.
- **`bun:sqlite`** is aliased to a throwing shim. Always set
  `DATABASE_DRIVER=neon-http` (or any non-sqlite driver) so the
  sqlite code path never loads.

## Environment variables (all targets)

| Var                          | Required? | Notes                                        |
|------------------------------|-----------|----------------------------------------------|
| `APP_URL`                    | yes       | Admin UI origin (CORS + auth callbacks)      |
| `AUTH_SECRET`                | yes       | 32-byte random; signs sessions               |
| `DATABASE_URL`               | yes¹      | Postgres URL (¹ unless on Workers with D1). Supabase, Neon, Xata, Vercel PG, self-host all supported — see `docs/database-providers.md` for the matrix |
| `DATABASE_DRIVER`            | no        | `postgres-js` (default) or `neon-http` (required on Vercel Edge) |
| `EMAIL_PROVIDER` + `EMAIL_FROM` | no     | Email transport: `console`/`resend`/`sendgrid`/`mailgun`/`ses`/`smtp` (auto-detected from creds if `EMAIL_PROVIDER` unset; `smtp` not on Workers) |
| `RESEND_API_KEY` \| `SENDGRID_API_KEY` \| `MAILGUN_API_KEY`+`MAILGUN_DOMAIN` \| `SES_REGION`+`SES_ACCESS_KEY_ID`+`SES_SECRET_ACCESS_KEY` \| `SMTP_HOST`+`SMTP_PORT`+`SMTP_USER`+`SMTP_PASSWORD` | no | Credentials for the chosen email provider |
| `OAUTH_{GOOGLE,GITHUB,APPLE}_CLIENT_{ID,SECRET}` | no | enable each provider when both set; Apple's `_CLIENT_ID` is the Service ID, `_CLIENT_SECRET` is the signed JWT |
| `AUTH_PLUGINS`               | no        | Comma-separated: `passkey,magic-link,email-otp,anonymous`. TOTP two-factor is always on (not listed here) |
| `FUNCTIONS_FETCH_ALLOW`      | no        | Comma-separated host allow-list for ctx.fetch |
| `FUNCTIONS_EXEC_URL`         | no        | Base URL of a remote-http function executor  |
| `SANDBOX_RPC_TOKEN`          | no        | remote-http only — shared secret for ctx.* RPC |
| `SELF_URL`                   | no        | Required for cron-triggered remote-http RPC  |
| `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` | no¹ | ¹ Required on Vercel / Netlify Functions (no local fs in a Lambda zip); optional on Bun (defaults to fsStorage) and Workers (R2 binding preferred) |
| `S3_ENDPOINT`                | no        | Custom S3 endpoint for R2/B2/MinIO/Spaces    |
| `S3_REGION`                  | no        | Defaults to `auto`                           |
| `R2_PUBLIC_BASE`             | no        | Workers only. Public origin for the R2 bucket; activates cf.image edge resizing for public-ACL files. See `docs/storage.md`. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | no | Durable realtime transport for serverless (Vercel/Netlify), where the in-process pub/sub map doesn't survive between invocations. When both are set, realtime publish/subscribe fan out through an Upstash Redis stream per channel. Unset on Bun (in-proc) / Workers (Durable Object). |
| `ABLY_API_KEY`               | no        | Collaboration transport for serverless (`keyName:keySecret`). The server only mints channel-scoped token requests (`POST /api/realtime/collab-token`); the browser talks to Ably directly, so presence/field-awareness costs zero function invocations. Preferred over the Redis fallback on Vercel/Netlify; ignored where a Durable Object or long-lived process exists. See `docs/realtime.md`. |
| `CLOUD_REPORT_URL` + `CLOUD_REPORT_SECRET` + `CLOUD_PROJECT_ID` | no | **Managed-cloud only.** Set automatically by the backlex cloud provisioner so a tenant can opt-in report 5xx errors + AI token usage to the control plane. Self-hosted installs leave all three unset and never phone home — the reporting path is a no-op (`server/lib/cloud-report.ts`). |

## Verifying a deploy

```bash
curl https://your.app/health
# { "ok": true, "dialect": "pg" | "sqlite", "ts": 1730000000000 }
```

Then sign up at `https://your.app/sign-up` (or your admin URL); the first
user gets the `admin` role.

## Staying up to date

The one-click buttons and the git-clone flow create a **standalone copy** of
the repo in your own Git account — not a GitHub fork — so your instance does
**not** auto-track upstream `backlex/backlex`. Pulling in later releases is a
manual `git` step (then your platform's Git integration redeploys the push):

```bash
# one-time: register the upstream repo
git remote add upstream https://github.com/backlex/backlex

# each upgrade:
git fetch upstream
git merge upstream/main      # or: git rebase upstream/main
git push origin main         # → Cloudflare / Vercel / Netlify auto-redeploys
```

What happens automatically after the redeploy:

- **DB migrations** apply on the next request via `ensureMigrations`
  (`apps/web/src/server/context.ts`) — idempotent against the
  `__drizzle_migrations` ledger, so only new migrations run. There is no
  manual `db:migrate` step on managed deploys.
- **Build + deploy** are triggered by the push through the platform's native
  Git integration — no GitHub Actions workflow needed.

What you still do by hand:

- **New env vars.** Check the release notes for any newly *required* variable
  (e.g. a new provider key) and add it in the platform dashboard before — or
  together with — the upgrade.
- **Conflicts.** A clean, unmodified instance merges without conflict. If you
  edited code, conflicts are limited to the files you touched.

**Deno Deploy caveat:** the `--source local` CLI flow is **not** git-linked, so
`git push` won't redeploy it. After pulling, either re-run
`deno deploy --org <org> --app <app> --prod`, or connect the repo at
app.deno.com for push-to-deploy (see [Deno Deploy](#deno-deploy-managed)).
