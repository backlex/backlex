---
title: Deployment
description: Ship the same source to Bun, Cloudflare Workers, Vercel Edge, or Netlify Edge.
---

workeros runs on four targets from the same source. Pick one based on the
constraints you need.

|                    | Bun (self-host)   | Cloudflare Workers   | Vercel Edge          | Netlify Edge         |
|--------------------|-------------------|----------------------|----------------------|----------------------|
| **Database**       | SQLite or PG      | D1 or Hyperdrive→PG  | PG via `DATABASE_DRIVER=neon-http` (required) | PG (postgres-js works under Deno; `neon-http` recommended) |
| **Storage**        | local fs / S3 / `Bun.S3Client` | R2 (S3 fallback) | S3 (`aws4fetch`) **required** — boot fails without it | S3 (`aws4fetch`) **required** — boot fails without it |
| **Realtime**       | in-proc + SSE     | Durable Objects + WS | 503 (not supported)  | 503 (not supported)  |
| **SAML**           | yes               | yes (nodejs_compat)  | 503 (xml-crypto unavailable) | 503 (xml-crypto unavailable) |
| **LDAP / SMTP**    | yes               | 503 (no raw TCP)     | 503 (no raw TCP)     | 503 (no raw TCP)     |
| **Sandbox**        | Bun worker        | QuickJS / remote HTTP | QuickJS / remote HTTP | QuickJS / remote HTTP |
| **Image**          | `Bun.Image`       | CF Image Resize      | passthrough          | passthrough          |
| **Cron**           | setInterval       | wrangler triggers    | vercel.json crons (Vercel sends `Authorization: Bearer $CRON_SECRET` automatically) | scheduled function pings `/api/_cron/tick` with `x-cron-secret: $CRON_SECRET` |
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

`vercel.json` at the repo root deploys both admin (static SPA from
`apps/web/dist/client`) and API (`api/index.ts` — a tiny shim that
re-exports `apps/web/src/server/entries/vercel.ts` as an Edge Function).
Cron triggers ping `/api/_cron/tick` once per minute.

### Git integration (recommended)

The typical setup is to connect the GitHub repo from the Vercel dashboard
and let every push to `main` auto-deploy. No GitHub Actions workflow is
needed.

1. **vercel.com → Add New → Project** → pick the workeros repo.
2. **Framework Preset:** `Other`. The `vercel.json` in the repo root
   overrides install/build/output, so the preset only affects defaults.
3. **Root Directory:** leave at repo root (`/`). Do *not* point it at
   `apps/web`; the build command already runs Vite inside the workspace.
4. **Environment Variables** — set these on Production (and ideally
   Preview too). Minimum:
   - `APP_URL` — `https://your-project.vercel.app` (or the custom domain)
   - `AUTH_SECRET` — `openssl rand -hex 32`
   - `DATABASE_URL` — Neon HTTP connection string
   - `DATABASE_DRIVER=neon-http` — forced on by the Vercel entry, but
     declare it for clarity
   - `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ optional
     `S3_ENDPOINT`, `S3_REGION`) — edge boot fails without storage
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
vercel env add DATABASE_URL    # Neon HTTP recommended for Edge
vercel env add AUTH_SECRET
vercel deploy --prod
```

### Database driver on Edge

Vercel's edge runtime doesn't expose `node:net`, so plain `postgres-js`
won't connect. Two options:

1. **Neon HTTP** — `@neondatabase/serverless` works over HTTP.
   ```bash
   bun add @neondatabase/serverless --workspace=@workeros/db
   ```
   Then swap `createPgClient` to use Neon's pooler. (Drizzle has
   `drizzle-orm/neon-http` adapter.) workeros doesn't ship this swap by
   default — apply locally if you target Vercel.

2. **Vercel Postgres** — same Neon driver, managed inside Vercel.

### Storage on Edge

Edge functions can't write to disk; set the S3 env vars and the storage
adapter switches to the S3 path automatically. Works with AWS S3,
Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi —
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

`netlify.toml` at the repo root mirrors Vercel — admin SPA + edge
function for `/api/*` + scheduled function for cron. Edge function source
lives in `apps/web/netlify/edge-functions/entry.ts`, scheduled function in
`apps/web/netlify/functions/cron.ts`.

### Git integration (recommended)

1. **app.netlify.com → Add new site → Import an existing project** → pick
   the workeros repo.
2. **Base directory:** leave empty (repo root). The `netlify.toml` already
   sets `base = ""`.
3. **Build command, Publish directory:** leave empty too — `netlify.toml`
   overrides both (`command = "DEPLOY_TARGET=netlify bun install
   --frozen-lockfile && DEPLOY_TARGET=netlify bun run --cwd apps/web
   build"`, `publish = "apps/web/dist/client"`).
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

```bash
netlify init
netlify env:set DATABASE_URL postgres://...
netlify env:set AUTH_SECRET $(openssl rand -hex 32)
netlify deploy --prod
```

The same edge-runtime caveats apply: Postgres needs an HTTP-friendly
driver; storage needs S3.

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
| `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` | no¹ | ¹ Required on Vercel/Netlify edge (no fs); optional on Bun (defaults to fsStorage) and Workers (R2 binding preferred) |
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
