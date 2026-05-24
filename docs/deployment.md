---
title: Deployment
description: Ship the same source to Bun, Cloudflare Workers, Vercel, or Netlify (all Node serverless except Bun and Workers).
---

workeros runs on four targets from the same source. Pick one based on the
constraints you need.

|                    | Bun (self-host)   | Cloudflare Workers   | Vercel Functions (Node 22, Build Output API) | Netlify Functions (Node 22) |
|--------------------|-------------------|----------------------|----------------------|------------------------------|
| **Database**       | SQLite or PG      | D1 or Hyperdrive→PG  | PG via `DATABASE_DRIVER=neon-http` (recommended — HTTP avoids cold-start TCP handshake) | PG via `DATABASE_DRIVER=neon-http` (recommended) |
| **Storage**        | local fs / S3 / `Bun.S3Client` | R2 (S3 fallback) | S3 (`aws4fetch`) **required** — Lambda zip has no local fs | S3 (`aws4fetch`) **required** — Lambda zip has no local fs |
| **Realtime**       | in-proc + SSE     | Durable Objects + WS | loads but impractical (Lambda is stateless, SSE capped by function execution limit) | loads but impractical (same Lambda caveat) |
| **SAML**           | yes               | yes (nodejs_compat)  | yes (Node 22 native crypto) | yes (Node 22 native crypto) |
| **LDAP / SMTP**    | yes               | 503 (no raw TCP)     | yes (Node 22 has raw TCP) | yes (Node 22 has raw TCP) |
| **Sandbox**        | Bun worker        | QuickJS / remote HTTP | QuickJS / remote HTTP | QuickJS / remote HTTP |
| **Image**          | `Bun.Image`       | CF Image Resize      | passthrough          | passthrough          |
| **Cron**           | setInterval       | wrangler triggers    | `.vercel/output/config.json` crons (emitted by `scripts/build-vercel-output.ts`; Vercel sends `Authorization: Bearer $CRON_SECRET` automatically) | scheduled function pings `/api/_cron/tick` with `x-cron-secret: $CRON_SECRET` |
| **Cost**           | VPS               | $0–5/mo              | $0–20/mo             | $0–19/mo             |

## Bun (self-host)

```bash
APP_URL=https://your.app \
DATABASE_URL=postgres://user:pass@host:5432/workeros \
AUTH_SECRET=$(openssl rand -hex 32) \
bun run --cwd apps/web dev:bun
```

For a managed process: systemd unit, Docker, or `pm2`. The Bun scheduler
boots inside `apps/web/src/server/entries/bun.ts`; cron functions tick
every 30 seconds.

## Cloudflare Workers

`apps/web/wrangler.toml` covers the bindings. First-time setup:

```bash
cd apps/web

wrangler d1 create workeros          # paste id into wrangler.toml
wrangler r2 bucket create workeros-files
wrangler vectorize create workeros-embeddings --dimensions=1536 --metric=cosine

wrangler secret put AUTH_SECRET
wrangler secret put RESEND_API_KEY        # optional — email provider key
                                          # (or SENDGRID_API_KEY / MAILGUN_API_KEY / SES_*)
wrangler secret put OAUTH_GOOGLE_CLIENT_ID  # optional
# ...
# EMAIL_FROM (and EMAIL_PROVIDER) aren't secrets — put them in wrangler.toml [vars].
# smtp is not available on Workers; use an HTTP provider here.

wrangler d1 migrations apply workeros --remote
wrangler deploy
```

### Git integration (recommended)

Connect the GitHub repo from the Cloudflare dashboard and let every push to
`main` auto-deploy. No GitHub Actions workflow is needed.

1. **dash.cloudflare.com → Workers & Pages → workeros-api → Settings → Builds**
   → **Connect** → pick the workeros repo.
2. **Production branch:** `main`.
3. **Build command:** `bun run db:migrate:d1:remote && bun run build`
   (the migration runs first so deploy never fronts a schema mismatch; the
   build container's `wrangler` is auto-authenticated, no token needed).
4. **Deploy command:** `cd apps/web && bunx wrangler deploy` — the
   `cd` is mandatory. wrangler 4 detects Bun workspaces and refuses
   to run from repo root with `"application detection logic has been
   run in the root of a workspace"`. `apps/web/` is where
   `wrangler.toml` lives and where the Vite build emits
   `dist/workeros_api/` + `dist/client/`.
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

## Vercel

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

1. **vercel.com → Add New → Project** → pick the workeros repo.
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
S3_BUCKET=workeros
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

- **Realtime SSE** loads but is impractical: Lambda is stateless, so
  the in-process pub/sub `Map` doesn't survive cold starts, and
  function execution time caps the SSE stream. Use Cloudflare Workers
  (Durable Object) or Bun self-host for realtime.
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
bunx wrangler r2 bucket dev-url enable workeros-files
bunx wrangler r2 bucket dev-url get workeros-files
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
   the workeros repo.
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
pass `--filter @workeros/web` to keep it non-interactive:

```bash
netlify env:set DATABASE_URL postgres://... --filter @workeros/web
netlify env:set AUTH_SECRET $(openssl rand -hex 32) --filter @workeros/web
netlify deploy --build --prod --filter @workeros/web
```

For a brand-new site, `netlify api createSiteInTeam` plus a manual
"Link site to Git" in the dashboard avoids the interactive flow
entirely (you need the GitHub OAuth + deploy key only Netlify's
dashboard can provision).

### Runtime caveats

Netlify Functions run on Node 22, so the Bun-self-host surface is
mostly available — SAML, LDAP, SMTP, samlify all load (full
`node:crypto`/`node:net`/`node:tls`). Two exceptions:

- **Realtime SSE** loads but is impractical: Lambda is stateless, so
  the in-process pub/sub `Map` doesn't survive cold starts, and
  function execution time caps the SSE stream. Use Cloudflare Workers
  (Durable Object) or Bun self-host for realtime.
- **`bun:sqlite`** is aliased to a throwing shim. Always set
  `DATABASE_DRIVER=neon-http` (or any non-sqlite driver) so the
  sqlite code path never loads.

## Environment variables (all targets)

| Var                          | Required? | Notes                                        |
|------------------------------|-----------|----------------------------------------------|
| `APP_URL`                    | yes       | Admin UI origin (CORS + auth callbacks)      |
| `AUTH_SECRET`                | yes       | 32-byte random; signs sessions               |
| `DATABASE_URL`               | yes¹      | Postgres URL (¹ unless on Workers with D1)   |
| `EMAIL_PROVIDER` + `EMAIL_FROM` | no     | Email transport: `console`/`resend`/`sendgrid`/`mailgun`/`ses`/`smtp` (auto-detected from creds if `EMAIL_PROVIDER` unset; `smtp` not on Workers) |
| `RESEND_API_KEY` \| `SENDGRID_API_KEY` \| `MAILGUN_API_KEY`+`MAILGUN_DOMAIN` \| `SES_REGION`+`SES_ACCESS_KEY_ID`+`SES_SECRET_ACCESS_KEY` \| `SMTP_HOST`+`SMTP_PORT`+`SMTP_USER`+`SMTP_PASSWORD` | no | Credentials for the chosen email provider |
| `OAUTH_{GOOGLE,GITHUB,APPLE}_CLIENT_{ID,SECRET}` | no | enable each provider when both set; Apple's `_CLIENT_ID` is the Service ID, `_CLIENT_SECRET` is the signed JWT |
| `AUTH_PLUGINS`               | no        | Comma-separated: `passkey,magic-link,email-otp,anonymous` |
| `FUNCTIONS_FETCH_ALLOW`      | no        | Comma-separated host allow-list for ctx.fetch |
| `FUNCTIONS_EXEC_URL`         | no        | Base URL of a remote-http function executor  |
| `SANDBOX_RPC_TOKEN`          | no        | remote-http only — shared secret for ctx.* RPC |
| `SELF_URL`                   | no        | Required for cron-triggered remote-http RPC  |
| `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` | no¹ | ¹ Required on Vercel / Netlify Functions (no local fs in a Lambda zip); optional on Bun (defaults to fsStorage) and Workers (R2 binding preferred) |
| `S3_ENDPOINT`                | no        | Custom S3 endpoint for R2/B2/MinIO/Spaces    |
| `S3_REGION`                  | no        | Defaults to `auto`                           |
| `R2_PUBLIC_BASE`             | no        | Workers only. Public origin for the R2 bucket; activates cf.image edge resizing for public-ACL files. See `docs/storage.md`. |

## Verifying a deploy

```bash
curl https://your.app/health
# { "ok": true, "dialect": "pg" | "sqlite", "ts": 1730000000000 }
```

Then sign up at `https://your.app/sign-up` (or your admin URL); the first
user gets the `admin` role.
