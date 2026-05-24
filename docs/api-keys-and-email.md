---
title: API keys, access tokens, Email & OAuth
description: Personal access keys, access / refresh token pair, per-workspace email transports, and OAuth provider wiring.
---

This page covers the bearer-token + outbound-mail surfaces that ship
with workeros's auth plane (Phase 5): personal access keys (PAKs),
the access / refresh token pair issued to workspace end-users, email
transport selection (env-level + per-workspace overrides), and OAuth
social providers.

## Access / refresh tokens (workspace end-users)

Every app-plane sign-in issues a token *pair*:

- The `app_sessions` row is the long-lived, revocable **refresh
  token** (its opaque `app_<uuid…>` value).
- On top of it, `apps/web/src/server/lib/jwt.ts` mints a short-lived
  **access token** — TTL set by `ACCESS_TOKEN_TTL_SECONDS` (default
  15 min). HS256 JWT keyed off `AUTH_SECRET`, hand-rolled on Web
  Crypto (no dependency, works on all four runtimes), verified
  statelessly (no DB hit) in `middleware/session.ts`.

Sign-in responses carry:

```ts
{ accessToken, refreshToken, expiresIn, tokenType, token /* legacy */ }
```

`token` is `=== refreshToken`, kept so older opaque-bearer clients
don't break.

Refresh: `POST /api/t/<slug>/auth/token/refresh` exchanges a refresh
token (JSON body `refreshToken` / legacy `token`, or
`Authorization: Bearer`) for a fresh access token.

`middleware/session.ts` accepts either shape on `Authorization:
Bearer` for app-plane callers — JWT first (fast path via
`verifyAccessToken`), opaque `app_sessions` lookup as fallback.

**Trade-off**: a JWT stays valid for its full TTL even after the
refresh token is revoked. Revocation (deleting the `app_sessions`
row) takes effect within ≤ TTL.

The admin / control-plane better-auth instance (`packages/auth`) also
has the `bearer` plugin always on, so native admin clients can
authenticate with `Authorization: Bearer <session-token>` instead of
a cookie.

## API keys (personal access keys)

The `api_keys` table stores hashed personal access keys. The
full key format is `pak_<8-hex prefix>_<32-hex secret>`. Only the
SHA-256 of the secret is stored; the plaintext is returned **exactly
once** on POST and is never retrievable.

- `apps/web/src/server/services/api-keys.ts` handles create / list /
  revoke / lookup.
- Auth middleware (`middleware/session.ts`) tries the better-auth
  cookie session first, then falls back to
  `Authorization: Bearer pak_...`. A resolved key impersonates its
  `user_id` so the request inherits that user's roles + permissions,
  and pins the request to the key's `tenant_id`.
- `name` is optional on POST (a timestamped default is generated).
  `expires_at` is optional — lookup rejects expired keys.

### Role scoping

A key may set `role_id`. When present:

- The request resolves permissions against **only** that role (no
  implicit `authenticated`).
- Resolution only succeeds while the owner still holds that role
  (`loadRolesForUser` / `loadTenantRoleNames` both gate on
  `(user_roles ⋈ roles) WHERE role.id = key.role_id`). A scoped key
  can never grant more than its owner currently has.
- Creation rejects a `role_id` the owner doesn't hold — admins
  included (grant yourself the role first if you want a narrow
  self-key).

`GET /api/api-keys/available-roles` lists roles the caller may bind:
admins get every workspace role; everyone else gets only roles they
hold. `auth.apiKeyRoleId` carries the scope through the middleware
chain (set in `app.ts` `AppBindings` and `AuthSubject` in
`@workeros/core`).

## Email transports

The `EmailAdapter` interface lives in
`packages/core/src/adapters/email.ts`:

```ts
send({ to, subject, text, html?, from? }): Promise<void>
```

Implementations live in
`apps/web/src/server/adapters/email.{console,resend,sendgrid,mailgun,ses,smtp}.ts`.

### Env-level selection

`apps/web/src/server/lib/email-select.ts` is the single place
transports get wired. It exports:

- `EmailSpec` — the normalized union both layers below compile to.
- `buildEmailAdapter(spec)` — turns a spec into an adapter.
- `selectEmailAdapter(env)` — picks the deployment transport.

`selectEmailAdapter(env)` rules:

1. If `EMAIL_PROVIDER` is set (`console | resend | sendgrid | mailgun
   | ses | smtp`), use it.
2. Otherwise auto-detect from whichever provider has complete
   credentials. Priority: `resend → sendgrid → mailgun → ses → smtp`.
3. Otherwise fall back to the `console` adapter (logs to stdout —
   fine for dev).

Every provider also needs `EMAIL_FROM`. The HTTP providers
(`resend` / `sendgrid` / `mailgun` / `ses`) work on every runtime —
SES is SigV4-signed via `aws4fetch`.

**`smtp` is nodemailer-based and only works off Cloudflare Workers**
(no raw TCP). The Worker bundle aliases `nodemailer` to a throwing
stub (`shims/nodemailer-shim.ts`, wired in both `wrangler.toml
[alias]` and `vite.config.ts`); `buildEmailAdapter` skips `smtp` on
Workers with a warning.

### Per-workspace email

The `email_config` table holds workspace-level overrides:

- PK is `tenant_id`, or the `_global` sentinel for the instance-wide
  override row.
- Columns: `provider`, `from_address`, `config` (jsonb of non-secret
  knobs), `secrets` (jsonb of `enc:v1:…` ciphertext, AES-256-GCM via
  `lib/crypto`, keyed off `AUTH_SECRET` — same scheme as
  `auth_config.clientSecretEnc`).

Resolution order: workspace row → `_global` row →
`selectEmailAdapter(env)`. A row with `provider = "inherit"` (or a
blank/incomplete row) falls through.

Files:

- `services/email-config.ts` — `loadEmailConfigRow`,
  `resolveEmailAdapter`. Mirrors `services/auth-config.ts`.
- `routes/email-config.ts` — admin-only `GET` / `PUT` / `POST /test`.
  Secrets are write-only; `GET` returns only `secretsSet` flags. A
  `PUT` invalidates `getTenantAuth`'s cache via
  `invalidateTenantAuth`.
- Reads degrade to the env-default if the table isn't migrated yet.

### How to send mail in code

**Always send via `ctx.emailFor(tenantId)` (memoized per request) —
not `ctx.email`.** `ctx.email` is the env-derived deployment default
that `emailFor` ends at; use it only for system mail with no
workspace context.

Already routed through `emailFor`:

- `sendTemplatedEmail`
- `getTenantAuth` (end-user verification / magic-link / OTP / reset
  mail)
- The Functions sandbox `email.send` RPC
- Workspace-invite mailers

Never reach for an email SDK directly.

## OAuth providers

OAuth wiring is env-level (deployment default) with per-workspace
overrides through `auth_config.socialProviders`.

Env vars: `OAUTH_GOOGLE_CLIENT_ID/SECRET`,
`OAUTH_GITHUB_CLIENT_ID/SECRET`, `OAUTH_APPLE_CLIENT_ID/SECRET`.

- Apple's `_CLIENT_ID` is the Service ID; `_CLIENT_SECRET` is the
  JWT signed with the Apple key.
- If both id + secret are present for a provider, it's wired into
  better-auth's `socialProviders` automatically.
- A workspace with a configured provider in `auth_config.socialProviders`
  takes precedence over env-level wiring (see
  `services/auth-config.ts`).

Endpoints follow better-auth conventions:

- `/api/auth/sign-in/social`
- `/api/auth/callback/<provider>`

When adding a new auth surface, prefer extending the better-auth
plugin set (passes through `databaseHooks` so the first-user-becomes-admin
logic still applies) over rolling a parallel sign-in flow.
