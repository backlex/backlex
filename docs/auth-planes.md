---
title: Auth planes & workspace end-users
description: The control-plane vs app-plane split — how admin users (running the dashboard) and workspace end-users (customers of the app built on a workspace) coexist with separate tables, sessions, and APIs.
---

backlex is built for **two distinct audiences inside the same instance**:

- The team running the dashboard — operators, developers, internal
  admins. They sign into `app.your-backlex.com`, configure
  collections, write permissions, invite teammates.
- The end-users of whatever product is being *built on top of* a
  workspace — the customers of a SaaS, the readers of a CMS, the
  members of a community. They never see the dashboard. They only
  ever talk to the workspace's own auth surface and its data API.

Mixing those two pools into a single user table breaks down fast:
admin sign-ups and customer sign-ups have different policies, you
need separate suspension states, you don't want a workspace's
customer to be able to switch into the dashboard with the same cookie,
and a workspace built for "1000 customers per tenant" can't share
a row range with the much smaller "5 admins per company" pool.

This page is the single conceptual reference for the split. Each
section points at the code rather than restating it, so when a
detail changes the doc tells you where to look.

## The two-plane model

`auth.plane` (set on `c.var.auth` by
`apps/web/src/server/middleware/session.ts`) tags every authenticated
request with one of two values:

| Plane          | Who                          | Tables it touches                                            | Auth surface                       | Cookie / token              |
|----------------|------------------------------|--------------------------------------------------------------|------------------------------------|------------------------------|
| `"platform"`   | Admins running the dashboard | `users`, `sessions`, `accounts`, `verifications`, `passkeys` | `/api/auth/*` (better-auth)        | `better-auth.*` cookies + opaque session tokens; PAKs (`pak_…`) for machine-to-machine |
| `"app"`        | Workspace customers          | `app_users`, `app_sessions`, `app_accounts`, `app_verifications`, `external_identities` | `/api/t/<slug>/auth/*` (per-workspace better-auth) | `Authorization: Bearer <access-or-refresh-token>` |

Both planes share the same `tenants` table and the same role / permission
machinery (`roles` + `permissions` rows are tenant-scoped; assignments
live in `user_roles` for platform users and `app_user_roles` for
end-users — see `packages/db/src/pg/schema.ts:295` onward).

The plane tag flows from `sessionMiddleware` into `tenantMiddleware`
into `requirePermission`. Every downstream check — tenant resolution,
role load, condition compilation — can branch on it without re-asking
"which kind of user is this". For example,
`apps/web/src/server/middleware/tenant.ts:204` pins an app-plane request
to the workspace stamped on its session row and *ignores* any
`X-Backlex-Tenant` header — a customer's frontend can never accidentally
walk into another tenant's data even if it sends one.

## Tables at a glance

```
platform pool                                  app (workspace end-user) pool
─────────────                                  ──────────────────────────
users                                          app_users          tenant_id, status, email, …
sessions                                       app_sessions       tenant_id, user_id, token, …
accounts            (OAuth links)              app_accounts       tenant_id, user_id, provider_id, …
verifications                                  app_verifications  tenant_id, identifier, value, expires_at
passkeys

           ──────── shared by both ────────
           tenants            (workspaces — id, slug, project, env, …)
           tenant_members     (which platform user belongs to which workspace)
           roles              (tenant-scoped or global; `admin` flag = bypass)
           permissions        (role + collection + action + condition + fields)
           external_identities (federated identity ↔ user, with `plane` discriminator)
           auth_config        (per-workspace provider + policy overrides)
           email_config       (per-workspace email transport)
           saml_providers     (per-workspace SAML 2.0 IdPs)
           ldap_configs       (per-workspace LDAP / AD)
```

Load-bearing details worth pinning:

- `app_users.email` is unique **per tenant**
  (`app_users_tenant_email_idx`, `packages/db/src/pg/schema.ts:219`).
  A signup with `a@b.co` in workspace A is a *different identity* from
  the same email in workspace B; they're not even visible to each
  other's better-auth instance. Platform `users.email` is globally
  unique.
- `app_sessions.token` is the opaque refresh token. The shorter access
  token (JWT) lives only in memory — see [JWT bridge](#jwt-bridge).
- `app_user_roles` is parallel to `user_roles` but keyed by
  `app_users.id`. The permission resolver drops any role flagged
  `admin` for app-plane callers — workspace end-users can never inherit
  the admin bypass (`packages/db/src/pg/schema.ts:331`).
- `external_identities.plane` is the discriminator that says whether
  `user_id` references `users.id` (platform) or `app_users.id` (app).
  There's no FK because the referent table depends on the plane —
  same pattern `tenant_members.user_id` uses
  (`packages/db/src/pg/schema.ts:1042`).

## Workspaces (`tenants`)

A *workspace* is a `tenants` row. It carries:

- `slug` — URL-safe handle. Used in `/api/t/<slug>/auth/...` and on
  the admin sidebar tile (`packages/db/src/pg/schema.ts:31`).
- `project` / `branch` / `env` — informational tags surfaced in the
  admin UI (e.g. "default / main / production"). Not load-bearing.
- A 12-char prefix derived from the tenant id — used as the default
  physical-table namespace `c_<tenantPrefix12>_<slug>` so two
  workspaces never collide when they pick the same collection slug
  (`apps/web/src/server/routes/collections.ts:423`). The convention is
  a default, not an invariant — an adopted collection can wrap any
  existing table name.

Admin CRUD lives in `apps/web/src/server/routes/tenants.ts`:

| Method + path                       | Purpose                                                  |
|-------------------------------------|----------------------------------------------------------|
| `GET    /api/tenants`               | List workspaces the caller belongs to                    |
| `POST   /api/tenants`               | Create a workspace; caller becomes owner + `admin` role  |
| `POST   /api/tenants/switch`        | Set the `backlex-tenant` cookie + persist `active_tenant_id` |
| `GET    /api/tenants/{id}/members`  | List `tenant_members`                                    |
| `POST   /api/tenants/{id}/members/invite` | Send a 7-day invite token (best-effort mail via workspace transport) |
| `DELETE /api/tenants/{id}/members/{memberId}` | Remove a membership                              |
| `POST   /api/tenants/accept`        | Consume an invite token, bind to caller, seed RBAC role  |

`/switch` is the only endpoint that mutates the *active* workspace —
everything else respects whatever `tenantMiddleware` resolved (see
`apps/web/src/server/middleware/tenant.ts:165`). Resolution order:
`X-Backlex-Tenant` header → `backlex-tenant` cookie →
`users.active_tenant_id` → first membership → `ensureDefaultTenant`.

## End-user auth surface (`/api/t/:slug/auth/*`)

Every workspace gets its own complete auth surface — what would be a
separate "auth as a service" product if you bolted it on after the fact.
The router (`apps/web/src/server/routes/tenant-auth.ts`) mounts these
endpoints under `/api/t/<slug>/auth`:

| Method + path                                | Purpose                                                                       |
|----------------------------------------------|-------------------------------------------------------------------------------|
| `GET  /providers`                            | Public discovery — provider list + policy flags for the sign-in screen. No secrets. (`tenant-auth.ts:289`) |
| `POST /sign-up/email`, `/sign-in/email`, `/sign-out`, `/get-session`, … | Forwarded to the workspace's better-auth instance (`tenant-auth.ts:738`). |
| `POST /sign-in/social`, `/callback/<provider>` | Social OAuth (Google / GitHub / Apple) — credentials from `auth_config` first, then env-level. |
| `POST /sign-in/magic-link`                   | One-time email link. Requires the `magic-link` plugin enabled for the workspace. |
| `POST /sign-in/email-otp`, `.../verify-email-otp` | Email-code (OTP) sign-in. Requires the `email-otp` plugin.            |
| `GET  /saml/<provider-slug>/login`           | SP-initiated SAML — builds AuthnRequest, persists request id, 302 to IdP. (`tenant-auth.ts:304`) |
| `POST /saml/<provider-slug>/acs`             | Assertion Consumer — verifies signature + audience + NotOnOrAfter, blocks replays, provisions `app_user`, issues session, redirects to validated `relayState` with `#token=…`. (`tenant-auth.ts:339`) |
| `GET  /saml/<provider-slug>/metadata`        | Publish SP metadata XML for IdP configuration. (`tenant-auth.ts:500`)         |
| `ALL  /saml/<provider-slug>/slo`             | SP- or IdP-initiated Single Logout. (`tenant-auth.ts:525`)                    |
| `POST /ldap/sign-in`                         | LDAP / AD simple bind. Per-(tenant, username, ip) rate-limit + optional `domainMatch` allow-list. (`tenant-auth.ts:569`) |
| `POST /token/refresh`                        | Exchange a refresh token for a fresh access JWT. (`tenant-auth.ts:695`)       |

The SAML and LDAP routes are mounted **before** the better-auth
catch-all so they aren't shadowed by it — see the ordering at
`tenant-auth.ts:288`.

`/api/t/*` is rate-limited per-IP on the sensitive subpaths (sign-in,
sign-up, password reset, magic link, OTP, 2FA) by the same middleware
that protects the control-plane router — see `app.ts:212`.

## Per-workspace better-auth instance

Each workspace runs its **own** better-auth instance. They are not
shared. The factory is
`packages/auth/src/tenant.ts::createTenantAuth`, which differs from
the control-plane `createAuth` in two load-bearing ways:

1. **Tenant-scoped adapter wrapper.** The Drizzle adapter is wrapped
   in `withTenantScope`
   (`packages/auth/src/tenant-adapter.ts`), so every read / write is
   AND-ed with `tenant_id = config.tenantId`. A query for "user with
   email a@b.co" in workspace A genuinely cannot see the workspace-B
   row even if it exists.
2. **Namespaced cookies + base path.** `cookiePrefix: wo_<slug>` and
   `basePath: /api/t/<slug>/auth` — so a browser can hold simultaneous
   sessions for multiple workspaces without them colliding
   (`packages/auth/src/tenant.ts:122`).

A `databaseHooks.session.create.before` hook blocks new sessions for
`status = "suspended"` end-users at the source — even before the
session row gets written (`packages/auth/src/tenant.ts:177`).

The instances are **cached per isolate** in
`apps/web/src/server/services/tenant-auth.ts::getTenantAuth`. The
cache is a 50-entry LRU with a 5-minute TTL plus explicit invalidation
through `invalidateTenantAuth(tenantId)`. The admin routes that mutate
auth-relevant config — `routes/auth-admin.ts` (PATCH `auth_config`),
`routes/email-config.ts` (PUT) and `routes/workspace-config.ts` — all
call it so the next request rebuilds with the new state. **TTL is the
fallback** for changes made on a different isolate (Workers run a
fleet of them); explicit invalidation is the fast path for the same
isolate that just made the change.

Why one instance per workspace and not one global instance? Because
the trusted-origin list, the cookie domain, the email transport,
the OAuth client id, the session lifetime, and the social-provider
set are all configurable per workspace. You can't share one
better-auth handle across workspaces without giving up that
configurability.

## Admin surface (`/api/app-users`)

Operators manage the active workspace's end-user pool via
`apps/web/src/server/routes/app-users.ts`. Admin-only (`requireAdmin`
middleware), scoped to whichever workspace `tenantMiddleware`
resolved for the request:

| Method + path                                       | Purpose                                                                  |
|-----------------------------------------------------|--------------------------------------------------------------------------|
| `GET    /api/app-users`                             | List end-users with their custom role assignments (`app_users.ts:95`)    |
| `PUT    /api/app-users/{id}/roles`                  | Replace role bindings; admin role rejected (`app_users.ts:159`)          |
| `PATCH  /api/app-users/{id}`                        | Update `status` (active/suspended) or `name`; suspending drops sessions (`app_users.ts:234`) |
| `GET    /api/app-users/{id}/sessions`               | List active `app_sessions` rows for the user                              |
| `DELETE /api/app-users/{id}/sessions/{sessionId}`   | Revoke a single session                                                   |
| `DELETE /api/app-users/{id}`                        | Delete the user + sessions + OAuth accounts + role assignments. Explicit deletes (not FK cascade) because SQLite/D1 don't enforce FKs by default. |

Distinct from `/api/users`, which is the **control-plane** pool. The
two never overlap.

## Per-workspace config

Two key-value tables hold per-workspace overrides for the auth
behaviour the better-auth instance picks up:

- **`auth_config`** (`packages/db/src/pg/schema.ts:950`). PK is
  `tenant_id`, plus the `_global` sentinel for the instance-wide
  fallback. Columns: `providers` (jsonb of `{ email: { enabled }, github: { enabled, clientId, clientSecretEnc }, … }`),
  `policy` (jsonb — `requireEmailVerification`, `openSignup`,
  `mfaRequiredForAdmins`, …), `session_lifetime` (e.g. `30d` /
  `24h` / `90m`), `redirect_urls` (list of allowed callback origins —
  also folded into the CORS allow-list).
- **`email_config`** (`packages/db/src/pg/schema.ts:1131`). Same
  shape — per-workspace email transport. Full reference in
  [API keys, access tokens, email & OAuth](api-keys-and-email.md).

Resolution order is consistent across both:

```
workspace row  →  _global row  →  env-derived default
```

`apps/web/src/server/services/auth-config.ts::loadAuthConfigRow`
implements it. A row with `provider = "inherit"` (email) or with no
enabled providers (auth) falls through cleanly to the next level. Read
failures (e.g. the table not migrated yet on a brand-new instance)
also degrade to `null` rather than throw — the discovery endpoint
must never 500.

`resolveAuthSurface` builds the public `/providers` response. It only
ever advertises providers the *running worker* can actually serve —
workspace-level opts-in for OAuth need their own `clientId` +
`clientSecretEnc`; magic-link / email-OTP need to be explicitly
enabled and use the deployment's email adapter
(`services/auth-config.ts:154`).

## JWT bridge

App-plane sign-ins return a **token pair**: the long-lived, revocable
`app_sessions` row doubles as the *refresh token*, and on top of it
`apps/web/src/server/lib/jwt.ts::signAccessToken` mints a short-lived
*access token* (HS256 JWT, 15-minute TTL hardcoded as
`ACCESS_TOKEN_TTL_SECONDS`).

The middleware accepts either shape on `Authorization: Bearer`
(`apps/web/src/server/middleware/session.ts:177`):

1. JWT first (fast path — verify with `AUTH_SECRET`, no DB hit);
2. opaque `app_sessions` lookup as fallback.

The TTL is hardcoded because access-token revocation latency is a
property of the design — making it env-tunable invites someone to set
it to "24 hours" and accidentally turn revocation off. If you need a
different window, edit the constant.

Full reference (response shape, refresh endpoint, trade-offs):
[API keys, access tokens, email & OAuth](api-keys-and-email.md).

## SDK integration

`@backlex/client` has two modes, controlled by the `workspace` option:

```ts
import { createClient } from "@backlex/client";

// Admin / control-plane mode — talks to /api/auth/* (better-auth cookies).
const admin = createClient({ url: "https://api.example.com" });
await admin.auth.signIn({ email, password });
await admin.from("posts").list();

// App / workspace mode — talks to /api/t/<slug>/auth/*.
const app = createClient({
  url: "https://api.example.com",
  workspace: "acme",          // tenant slug
  token: localStorage.getItem("wks_token") ?? undefined, // restore prior session
});

await app.auth.signUp({ email, password, name });
// → response includes { accessToken, refreshToken, expiresIn, token, user }.
// The SDK captures `token` into memory; subsequent requests send it as
// `Authorization: Bearer <token>`.

localStorage.setItem("wks_token", app.auth.getToken() ?? "");
```

In app mode:

- `auth.signUp` provisions a row in `app_users` for the named
  workspace, not in the control-plane `users` pool.
- `auth.signIn` returns the same token pair the LDAP / SAML / email
  flows return. The SDK captures `token` (the refresh token) into
  `appToken` and replays it on every subsequent call — data and auth.
- `auth.providers()` returns the workspace's public auth surface
  (`/api/t/<slug>/auth/providers`) — provider list + policy flags
  ready to render a sign-in screen.

`createClient` source: `packages/client/src/index.ts`.

## End-to-end flow example

A SaaS app called "Acme" runs on top of backlex. The flow from
zero to "logged-in customer reading their data":

**1. Operator creates the workspace + a collection (control plane).**

```bash
# Browser session at app.backlex.example.com — admin cookie.
curl -X POST https://api.backlex.example.com/api/tenants \
  -H "content-type: application/json" \
  --cookie "$ADMIN_COOKIES" \
  -d '{ "name": "Acme", "env": "production" }'
# → { data: { id: "ten_…", slug: "acme", name: "Acme" } }

curl -X POST https://api.backlex.example.com/api/collections \
  -H "content-type: application/json" \
  -H "X-Backlex-Tenant: acme" \
  --cookie "$ADMIN_COOKIES" \
  -d '{ "slug": "tasks", "fields": [
        { "name": "title", "type": "text", "required": true },
        { "name": "done",  "type": "boolean" }
      ], "ownerScoped": true }'
```

**2. Operator enables Google + magic-link for Acme.**

PATCH `/api/admin/auth` (route in `apps/web/src/server/routes/auth-admin.ts`) writes the `auth_config`
row and invalidates the cached `getTenantAuth(acme)`. Next sign-in
request through `/api/t/acme/auth/*` builds a fresh better-auth
instance with the new providers.

**3. End-user signs up through the customer-facing app.**

```ts
import { createClient } from "@backlex/client";

const wks = createClient({
  url: "https://api.backlex.example.com",
  workspace: "acme",
});

const { user, token } = await wks.auth.signUp({
  email: "alice@example.com",
  password: "correct-horse-battery",
});

// Save the refresh token so the next page load doesn't sign them out.
localStorage.setItem("wks_token", wks.auth.getToken()!);
```

Under the hood: `POST /api/t/acme/auth/sign-up/email` → tenant-scoped
better-auth writes to `app_users` with `tenant_id = ten_…`. Bearer
plugin issues a session row in `app_sessions`. The custom token-pair
wrapper around it also issues a 15-minute access JWT.

**4. End-user reads / writes their data with the same client.**

```ts
const tasks = await wks.from("tasks").list();
// → GET /api/items/tasks
//   Authorization: Bearer <refresh-or-access-token>
// The `ownerScoped` flag means each app_user only sees their own rows.

await wks.from("tasks").create({ title: "Ship it", done: false });
```

Every request goes through:

- `sessionMiddleware` — bearer token matches an `app_sessions` row,
  sets `auth.plane = "app"`, `auth.userId`, `auth.appSessionTenantId`.
- `tenantMiddleware` — pins the request to `appSessionTenantId`
  (ignores any header / cookie). Loads role names from
  `app_user_roles`.
- `requirePermission("tasks", "read"|"create")` — resolves against
  `permissions` for the workspace; `ownerScoped` injects an `owner_id
  = $user.id` condition compiled to a Drizzle SQL fragment.

The same backlex instance, on the same routes, serves Acme's
internal operators and Alice's CRUD with no shared identity surface
between them.
