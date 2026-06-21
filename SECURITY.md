# Security

This document describes backlex's security model and how to report a
vulnerability. It is the authoritative reference for *what is enforced where*,
so reviewers and self-hosters can reason about the trust boundaries without
re-deriving them from the code.

## Reporting a vulnerability

**Do not open a public issue for security reports.** Use GitHub's private
vulnerability reporting (the **Security → Report a vulnerability** tab on the
repository) so the report stays embargoed until a fix ships. Include affected
version / commit, a reproduction, and the impact you observed. We aim to
acknowledge within a few business days.

Please don't run automated scanners against the managed cloud
(`*.backlex.com`) — test against a local or self-hosted instance instead.

## Trust boundaries at a glance

backlex is a multi-tenant backend. The two trust boundaries that matter most:

1. **Tenant isolation** — one workspace must never read or write another's data.
2. **Auth planes** — the *platform/control plane* (admins of the install) is
   distinct from the *app plane* (a workspace's own end-users). A token minted
   for one plane is never valid for the other.

Everything below is defense-in-depth layered on top of these two.

## Authentication & sessions

- Auth is built on **better-auth** (`packages/auth`). Email+password (8-char
  minimum), OAuth (Google/GitHub/Apple), magic-link, email-OTP, passkeys, and
  TOTP two-factor are available; TOTP is always loaded and opt-in per user.
- Sessions are cookie-based with `SameSite=Lax`; the session cookie is the CSRF
  mitigation for state-changing requests, complemented by better-auth's
  `trustedOrigins` check and the OAuth state cookie.
- **API keys** are stored as a hashed secret plus a short public prefix; the
  full token is shown exactly once at creation and never persisted in clear
  (`routes/api-keys.ts`). A key may be scoped to a single role, which is
  re-checked on every request, so revoking the role instantly defangs the key.
- **App-plane** end-users authenticate against a workspace's own better-auth
  instance under `/api/t/<slug>/auth/*`; their bearer token carries the issuing
  `tenantId` and is **pinned** to it — a stolen app token can't be pointed at
  another workspace.

## Authorization (permissions DSL)

Granular access lives in `roles` + `user_roles` + `permissions`. Each permission
row binds a role to a `(collection, action)` pair with an optional condition
(mini-DSL) and a field allow-list. The DSL compiles to a Drizzle `SQL` filter for
REST/GraphQL and an in-memory predicate for realtime. Wire new data resources
behind `requirePermission(collection, action)` and apply
`c.var.permission.whereSql` / `.fields`. Full reference: `docs/permissions.md`.

**Routes that intentionally do *not* call `requirePermission`:** account- and
settings-style endpoints that act on the caller's *own* identity or the active
workspace (e.g. `/api/account`, `/api/me`). These are gated by `requireUser` +
tenant membership rather than a collection permission, because the resource *is*
the caller. New endpoints that touch *collection data* must use
`requirePermission`; "acts on self / active tenant only" is the only accepted
reason to skip it, and should be stated in a comment at the route.

## Tenant isolation

Isolation is enforced at multiple layers, not just by permission filters:

- **Control plane** tables carry an explicit `tenant_id`; the active tenant is
  resolved per request in `middleware/tenant.ts` (header → cookie →
  `active_tenant_id` → membership), and a non-member is denied. A super-admin
  may *view* another workspace, but that cross-tenant shortcut is **never**
  granted to API keys and does not persist the visited tenant in the cookie.
- **App plane** users carry a `tenant_id` and every query is AND-ed with it via
  the tenant-scoped adapter wrapper (`packages/auth/src/tenant-adapter.ts`).
- **GraphQL** resolvers AND a `tenant_id` predicate in addition to the
  permission `whereSql`, so a shared adopted table can't leak rows cross-tenant.
- **Storage** keys are namespaced `tenants/<tenantId>/<logical>` and
  `guardLogicalKey` rejects path-traversal (`../`), absolute paths, backslashes,
  null bytes, and the reserved `tenants/` prefix (`services/storage/keys.ts`).

## Rate limiting & abuse protection

- **Per-IP auth limiter** on the sensitive better-auth subpaths (sign-in,
  sign-up, reset, magic-link, OTP, token refresh, SAML ACS) —
  `lib/auth-rate-limit.ts`.
- **Per-account lockout** tracks failed password attempts for one identifier
  across all IPs and locks with exponential backoff (`AUTH_LOCKOUT_*`).
- **Global per-identity API limiter** on `/api/*` (`lib/api-rate-limit.ts`),
  keyed by API key → user → IP. Off on self-host by default; auto-on for managed
  cloud; tune with `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_DISABLED`. Responses
  carry the IETF-draft `RateLimit-*` headers (and `Retry-After` on a 429).
- Backend is a Durable Object on Workers (authoritative across isolates) with an
  in-process fallback elsewhere; it **fails open** if the DO is unhealthy — a
  brief spike is preferred over locking every user out.

## SSRF protection

Server-side fetches to admin-supplied URLs (outbound webhooks, flow
`request`/`webhook` ops, web-push, URL imports) are guarded when
`BLOCK_PRIVATE_FETCH_HOSTS` is set — **auto-enabled on managed cloud**
(`CLOUD_PROJECT_ID`), where a tenant admin is not the host operator; **off by
default on self-host** so legitimate internal receivers keep working. The guard
(`services/storage/hosts.ts`) rejects private/loopback/link-local/CGNAT/metadata
hosts across octal, hex, decimal, bare-integer, and IPv4-mapped-IPv6 encodings,
and **re-validates every redirect hop** to defeat DNS-rebinding / redirect-to-
internal.

## Secrets handling

- All secrets come from env / platform bindings (`server/env.ts`); none are
  hardcoded. On Cloudflare Workers, `env` *is* the bindings object (vars +
  secrets); the Bun/Vercel/Netlify entries map a whitelist of `process.env`.
- Per-workspace OAuth client secrets are **encrypted at rest** in `auth_config`.
- API key secrets are hashed (see above); the `AUTH_SECRET` HMAC key, cron
  secret, and DB credentials are read from env only.
- **Rotation:** rotating `AUTH_SECRET` invalidates existing sessions (expected);
  rotate provider keys (OAuth, email, push/SMS, S3/R2) at the provider and update
  the binding/secret. API keys are rotated by issuing a new key and deleting the
  old row.

## Transport & browser hardening

- A strict **Content-Security-Policy** (`script-src 'self'`, no inline scripts)
  is applied to every route except the GraphiQL GET page, which gets a narrowly
  relaxed policy for its CDN bootstrap (`server/app.ts`). `secureHeaders()` adds
  HSTS / `X-Frame-Options` / `X-Content-Type-Options` / etc.
- **CORS** is an allow-list: `APP_URL`, `EXTRA_TRUSTED_ORIGINS`, and origins
  derived from each workspace's `auth_config.redirectUrls`. Anything else gets a
  non-matching ACAO and is blocked by the browser.

## Auditing & observability

- Mutations, sensitive reads, auth events, rate-limit trips, and account lockouts
  are written to the `activity` table with IP + user-agent (secrets redacted).
  See `docs/audit-logs.md`.
- Every request is assigned a correlation id (`x-request-id`, echoed on the
  response and in error envelopes) and emits a structured JSON log line; 5xx
  errors are additionally audited and, on managed cloud, reported to the control
  plane. Dead-lettered jobs and failed backups publish `system:*` events so an
  operator can wire a proactive alert (webhook / flow).

## Self-host vs managed cloud

Two guards auto-arm only on managed cloud (where the tenant admin is not the host
operator), and stay off on self-host by default:

| Guard | Self-host default | Managed cloud (`CLOUD_PROJECT_ID`) |
|---|---|---|
| SSRF host blocking | off (set `BLOCK_PRIVATE_FETCH_HOSTS`) | on |
| Global API rate limit | off (set `API_RATE_LIMIT_MAX`) | on |

Self-hosters who expose backlex to untrusted tenants should enable both.
