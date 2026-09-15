---
title: API keys, access tokens, Email & OAuth
description: Personal access keys, access / refresh token pair, per-workspace email transports, and OAuth provider wiring.
---

This page covers the bearer-token + outbound-mail surfaces that ship
with Backlex's auth plane (Phase 5): personal access keys (PAKs),
the access / refresh token pair issued to workspace end-users, email
transport selection (env-level + per-workspace overrides), and OAuth
social providers.

## Access / refresh tokens (workspace end-users)

Every app-plane sign-in issues a token *pair*:

- The `app_sessions` row is the long-lived, revocable **refresh
  token** (its opaque `app_<uuid…>` value).
- On top of it, `apps/web/src/server/lib/jwt.ts` mints a short-lived
  **access token** — 15-minute TTL hardcoded as `ACCESS_TOKEN_TTL_SECONDS`
  in that file (not env-configurable; edit the constant if you need a
  different window). HS256 JWT keyed off `AUTH_SECRET`, hand-rolled on
  Web Crypto (no dependency, works on every runtime), verified
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

### Minting one

In the admin, **Settings → API keys → New key**. Over the API — as an admin,
with a session cookie, because a key cannot mint itself the first time:

```bash
curl -X POST http://localhost:5173/api/api-keys \
  -H 'content-type: application/json' -H 'Origin: http://localhost:5173' \
  --cookie "$(your admin session cookie)" \
  -d '{"name":"ci"}'
```

```json
{ "data": { "prefix": "pak_7d84242e", "name": "ci", "roleId": null,
            "secret": "pak_7d84242e_613c…8ed7" },
  "warning": "Store this secret now. It cannot be retrieved later — only revoked." }
```

`secret` is the whole key and appears only in this response. Use it as
`Authorization: Bearer pak_…`, or hand it to the CLI once:

```bash
bunx @backlex/cli login --url http://localhost:5173 --key pak_…
```

| Route | Does |
|---|---|
| `POST /api/api-keys` | Create. Body: `name?`, `roleId?`, `expiresAt?`. Returns the secret once. |
| `GET /api/api-keys` | List your keys — prefixes and metadata, never the secret. |
| `DELETE /api/api-keys/{id}` | Revoke immediately. |
| `GET /api/api-keys/available-roles` | Roles this caller may bind with `roleId`. |

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
`@backlex/core`).

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

- `services/email/config.ts` — `loadEmailConfigRow`,
  `resolveEmailAdapter`. Mirrors `services/auth-config.ts`.
- `routes/email/config.ts` — admin-only `GET` / `PUT` / `POST /test`.
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

### Email templates

`email_templates` rows are rendered by `sendTemplatedEmail` with `{{ dotted.path }}`
placeholders (`renderTemplate` in `packages/core/src/email.ts`). A placeholder the
sender does not pass renders as an empty string, silently — and values are
inserted **unescaped**, like a [document template](/docs/documents/)'s.

**Overrides.** A row with `tenant_id = NULL` is the instance-wide default (backlex
seeds none); a workspace row with the same key shadows it.
`GET /api/admin/email-templates` returns one row per key with `inherited` /
`overridesDefault` flags. A workspace
never writes the shared row: `PATCH` on it writes (and returns) the workspace's
copy, `DELETE` on it is a 403, and `DELETE` on the copy restores the default and
returns it. `POST /api/admin/email-templates/send-test` renders an unsaved draft
with exactly the `vars` given and stores nothing.

**Built-in emails.** These keys are sent by backlex itself, each with a fallback
body, so nothing has to be stored until a workspace wants its own wording:

| Key | Sent by | Variables |
|---|---|---|
| `form_invite`, `form_reminder` | forms | `form`, `url`, `recipient.email`, `recipient.name` |
| `signature_request` | e-signature | `title`, `message`, `url`, `signer.email`, `signer.name`, `signer.role`, `expiresAt` |
| `signature_completed` | e-signature | `title`, `signers`, `documentHash` |
| `approval_request` | approvals | `title`, `message`, `url`, `approver.email`, `approver.name`, `approver.role`, `summary`, `summaryHtml`, `expiresAt` |
| `approval_approved`, `approval_rejected`, `approval_expired`, `approval_cancelled` | approvals | `title`, `outcome`, `reason`, `approvers` |
| `booking.confirmed`, `booking.cancelled`, `booking.rescheduled` | booking | `resource`, `when`, `manageUrl`, `customerName`, `confirmationMessage` |

The source of truth is `BuiltInEmailVars` in `@backlex/core/email-templates`:
every send site checks its `vars` with `satisfies BuiltInEmailVars["<key>"]`, and
the admin's variable list is derived from the same module, so the table above
and the page cannot drift from what is actually sent.
`apps/web/tests/email/email-template-catalog.test.ts` fails if a new literal-keyed
sender skips that check.

Any other key is a **custom** template: it receives whatever its caller passes.
A flow `email` step passes `data`, `$user.{id,email,roles}` and `$last` plus the
step's own `vars`; a scheduled report's covering message passes
`dashboard.{id,name,description}` and `report.{filename,panels,generatedAt}`.

**Sign-in, verification, password-reset and invite mail is not templated.** It is
composed inline in `packages/auth` and at each invite's send site, so no row on
this page changes it.

backlex used to seed instance-wide `verify`, `reset`, `magic`, `invite` and
`change_email` rows that no sender read. They are no longer seeded, and migration
`20260915120000_remove_unsent_system_email_templates` deletes the shared rows
(#384). A workspace's own row under one of those keys is kept and is an ordinary
custom template. Two things follow:

- A flow `email` step that names one of those keys, in a workspace with no copy
  of it, and has no subject and body of its own now fails its run with
  `Email template "<key>" not found and no fallback provided` instead of mailing
  the shared row with its links rendered empty.
- A backup taken before the migration still carries the shared rows, and a
  restore writes a missing instance-global row back — so restoring one brings them
  back. Remove them again with the migration's statement.

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
