---
title: SSO (SAML & LDAP)
description: Per-tenant SAML 2.0 and LDAP/Active Directory sign-in for the workspace end-user pool.
---

# SSO (SAML 2.0)

workeros supports per-tenant SAML 2.0 SSO **and** LDAP / Active Directory
for the **workspace end-user pool** (the `app_users` table, served via
`/api/t/<slug>/auth/*`). The admin app itself stays on the existing
`/api/auth/*` better-auth surface.

Both flows land in the same `external_identities` row store (SAML rows
carry `provider_type = 'saml'`, LDAP rows `provider_type = 'ldap'`).
SAML is covered first; LDAP / AD reference is at the bottom of this
page.

## How it fits together

```
+-------------+      AuthnRequest      +-------------+      SAMLResponse      +----------------+
|             | ---------------------> |             | <--------------------- |                |
|  customer   |                        |    IdP      |                        |    workeros    |
|  end-user   | <--------------------- | (Okta etc)  | -- 302 to ACS POST --> |  (workspace SP)|
|             |  sign-in form          |             |                        |                |
+-------------+                        +-------------+                        +----------------+
                                                                                       |
                                                                                       v
                                                                          provision app_user,
                                                                          issue app_session,
                                                                          302 to RelayState
                                                                          with #token=...
```

URL pattern, per workspace + provider slug:

| Purpose             | URL                                                                        |
|---------------------|----------------------------------------------------------------------------|
| SP-initiated login  | `${APP_URL}/api/t/<slug>/auth/saml/<provider-slug>/login?relayState=…`     |
| Assertion Consumer  | `${APP_URL}/api/t/<slug>/auth/saml/<provider-slug>/acs` (HTTP-POST)        |
| SP metadata XML     | `${APP_URL}/api/t/<slug>/auth/saml/<provider-slug>/metadata`               |
| SLO                 | `${APP_URL}/api/t/<slug>/auth/saml/<provider-slug>/slo`                    |

The slug part of the URL is the workspace slug (e.g. `default`), and the
provider slug is the one you choose when creating the SAML provider in the
admin UI (`Authentication → Add SAML`).

## Configure an IdP

The admin dialog has three tabs:

1. **From template** — pick Okta / Azure / Google / ADFS / JumpCloud / Auth0.
   The attribute map (`email`, `firstName`, `lastName`, `groups`) pre-fills
   with that vendor's defaults.
2. **Import metadata** — paste the IdP's metadata XML or its URL; we pull
   out the entityID, SSO URL, SLO URL, and signing cert.
3. **Manual entry** — type every field.

The signing cert is stored encrypted (AES-256-GCM via `AUTH_SECRET`); we
only ever decrypt it inside `resolveSamlProvider`, never return it.

### Okta

1. Okta admin → **Applications** → **Create App Integration** → SAML 2.0.
2. Single Sign On URL: paste the ACS URL from the workeros admin dialog
   (`Authentication → SAML provider → ACS URL`).
3. Audience URI (SP Entity ID): paste the SP entity id (= metadata URL by
   default).
4. Name ID format: `EmailAddress` (matches our default).
5. Attribute Statements: add `email`, `firstName`, `lastName`, and
   (optionally) `groups`. Use the names from the attribute-map fields in
   the workeros dialog.
6. Okta will give you a metadata URL — paste it into the workeros
   dialog's **Import metadata** tab and click **Fetch & parse**.

### Azure AD / Entra ID

1. Microsoft Entra admin → **Enterprise applications** → **New application**
   → **Create your own application** → **Non-gallery**.
2. Single Sign-On → SAML.
3. Identifier (Entity ID): paste the SP entity id.
4. Reply URL (ACS): paste the ACS URL.
5. Attributes: keep the default `http://schemas.xmlsoap.org/…` namespace —
   the workeros **Azure AD / Entra ID** template maps those already.
6. Download the **Federation Metadata XML** and import it via the dialog,
   or paste the SAML Signing Certificate (Base64) into the manual tab.

### Google Workspace

1. Workspace admin → **Apps** → **Web and mobile apps** → **Add app** →
   **Add custom SAML app**.
2. Download the metadata file Google offers; paste into the dialog's
   **Import metadata** tab.
3. Service provider details: ACS URL = the workeros ACS URL; Entity ID =
   SP entity id; Name ID format = `EMAIL`.
4. Attribute mapping: map `Primary email` → `email`, `First name` →
   `first_name`, `Last name` → `last_name`. The workeros **Google
   Workspace** template uses those keys.

## Security knobs

- **`linkByVerifiedEmail`** (off by default): when on, an existing app-user
  with the same email is linked to the SAML subject on first login. This
  makes a hostile IdP an account-takeover vector for any local account
  sharing an email; only enable it for IdPs you actually trust.
- **`wantSignedAssertions`** (on by default): rejects unsigned Assertions.
- **Replay protection**: every AssertionID lands in `app_verifications`
  until `NotOnOrAfter`. A second POST of the same Assertion before then
  is rejected with 401.
- **`InResponseTo`**: SP-initiated logins persist the AuthnRequest id in
  `app_verifications`; the ACS handler rejects responses whose
  `InResponseTo` doesn't match a known request.
- **`relayState`**: validated against `auth_config.redirectUrls` before
  every redirect (open-redirect protection).

## Group → role sync

Set `groupsToRoles` on a provider (admin UI field reserved for v2 — for
now use the JSON `attributeMap`/`groupsToRoles` columns directly). On
each login the provisioner snapshots the assigned roles on
`external_identities.rolesFromGroups`; the diff against the prior
snapshot drives the role-add and role-remove calls. Manual role
assignments aren't touched.

## Troubleshooting

- **"SAML audience mismatch"** → the IdP set `Audience` to a different
  value than the workeros SP entity id. Set the IdP's Audience URI / Entity
  ID to the SP entity id printed in the admin dialog.
- **"SAML issuer mismatch"** → the IdP's `<Issuer>` doesn't match the
  configured `entityId`. Copy the IdP entity id exactly from its metadata.
- **"SAML verification failed: digest mismatch"** → the IdP isn't signing
  with the cert we have on file (e.g. rotated cert, wrong cert). Re-paste
  the current cert via the dialog's manual tab.
- **Replay rejected immediately after IdP redirect** → can happen when the
  same browser tab re-POSTs the form (e.g. devtools "preserve log" re-fires
  a request). Treat as the design: re-initiate by hitting the `/login`
  endpoint again.
- **Clock skew** → samlify enforces `NotBefore` / `NotOnOrAfter`. If your
  IdP or workeros host is more than ~5 min off NTP, fix that first.
- **Cert format** → must be PEM (`-----BEGIN CERTIFICATE-----…`). DER
  binary or `.crt` with Windows line endings: re-export as PEM.
- **Cloudflare Workers runtime** — samlify imports `xml-crypto` which uses
  `node:crypto`. Workers expose those under `nodejs_compat`
  (`apps/web/wrangler.toml`); deploying without that flag will fail at boot.

---

## LDAP / Active Directory

LDAP / AD is the second federated-identity option alongside SAML. Use it when
your customer wants to keep username + password sign-in but bind against
their existing directory (no IdP-side SAML configuration needed).

### Runtime requirements

LDAP needs raw TCP via `node:net`/`node:tls`. **Cloudflare Workers do not
expose raw sockets**, so the LDAP adapter is gated off there: the route
returns 503 `UNAVAILABLE` and `apps/web/src/server/lib/auth-select.ts::
buildLdapAdapter` short-circuits to `undefined`. Use SAML on Workers, or run
the app on Bun / Vercel / Netlify where `node:net` is available.

The Worker bundle still resolves `import "ldapts"` — it's aliased to
`apps/web/src/server/shims/ldapts-shim.ts` (wired in both `wrangler.toml`
`[alias]` and `vite.config.ts`), which throws if anything ever actually
calls `new Client(...)` on Workers.

### Config storage

Per-workspace single-row config in `ldap_configs` (PK on `tenant_id`; the
`_global` sentinel works as the instance-wide fallback, same pattern as
`email_config`). `bind_password` and the optional `ca_pem` (custom TLS CA
for self-signed LDAPS) live in `secrets` as `enc:v1:…` AES-256-GCM
ciphertext — never returned by the API, just a per-key "is it set" flag.

Admin CRUD lives at `/api/admin/ldap-config` (GET, PUT, POST `/test`). The
admin UI in `Authentication → LDAP / Active Directory` writes through here.

### Sign-in flow

`POST /api/t/<slug>/auth/ldap/sign-in` with `{username, password}`:

1. Resolve the workspace + its LDAP config (missing/disabled/unsupported →
   503).
2. Per-`(tenant, normalized_username, ip)` rate limit
   (`config.rateLimitPerMinute`, default 10/min). Both successes and
   failures count.
3. If `domainMatch` is set and the username contains `@`, reject pre-LDAP
   when the domain isn't in the allow-list (saves the directory round-trip).
4. Service-bind, escape the username per RFC 4515, search by `userFilter`,
   then user-bind with the supplied password. Returns 401 on bad
   credentials *or* no match (same response + timing — no enumeration).
5. Provision via `provisionAppUser` (`linkByVerifiedEmail: false` —
   directory-bound users don't cross-link by default), apply
   `defaultRoleId` + `groupsToRoles`, issue an `app_sessions` row.
6. Returns `{token, user: {id, email}}` — *not* a redirect; LDAP is
   form-driven from the customer's own UI.

### Recipe: OpenLDAP

Typical OpenLDAP layout:

```
dc=example,dc=com
  ou=users
    uid=alice,ou=users,dc=example,dc=com  (objectClass: inetOrgPerson)
  ou=groups
    cn=engineers,ou=groups,dc=example,dc=com  (objectClass: groupOfNames)
      member: uid=alice,ou=users,...
```

Settings:
- **URL** — `ldaps://ldap.example.com:636` (use `ldaps://` in production).
- **Bind DN** — a read-only service account, e.g.
  `cn=workeros-readonly,ou=service,dc=example,dc=com`.
- **Base DN** — `ou=users,dc=example,dc=com`.
- **User filter** — `(&(objectClass=inetOrgPerson)(uid={{username}}))`.
- **Attribute map** — `email = mail`, `firstName = givenName`,
  `lastName = sn`, `groups = memberOf` (with the `memberof` overlay loaded
  on the OpenLDAP server; without it, switch `groups` to the empty string
  and forgo group sync).

### Recipe: Active Directory

Settings:
- **URL** — `ldaps://dc1.corp.example:636`. Workers can't reach AD over
  raw TCP — host on Bun/Node.
- **Bind DN** — typically a domain account: `cn=workeros,ou=Service
  Accounts,dc=corp,dc=example` or the UPN `workeros@corp.example`.
- **Base DN** — `dc=corp,dc=example` (or scope tighter — `ou=Users,...` —
  if all sign-in users live below one OU).
- **User filter** — `(&(objectClass=user)(sAMAccountName={{username}}))`
  for legacy login names, or
  `(&(objectClass=user)(userPrincipalName={{username}}))` when users sign
  in with their email/UPN.
- **Attribute map** — `email = mail`, `firstName = givenName`,
  `lastName = sn`, `groups = memberOf` (AD exposes group DNs directly on
  the user entry).
- **Pagination** — AD truncates `memberOf` at 1 500 entries and returns
  `memberOf;range=0-1499`. The adapter detects the ranged form and re-
  queries with `memberOf;range=<next>-*` until exhausted, so users in many
  groups still work.

### TLS notes

- **LDAPS** is just LDAP over TLS on port 636 — recommended for any
  internet-reachable directory.
- **StartTLS** (negotiate TLS on port 389) isn't supported by the current
  adapter; use LDAPS.
- **Self-signed CAs** — paste the root/intermediate PEM into the
  *Custom CA PEM* field. It's encrypted into `secrets.caPem` and only
  decrypted on the way into the TLS handshake.
- **Disable cert verification** (`Reject unauthorized certs` off) only as
  a last-ditch debugging step. Production deployments should always
  reject unauthorized certs.

### Filter-injection protection

The adapter escapes the username per RFC 4515 before substituting it into
`userFilter`. So `userFilter = "(uid={{username}})"` with username
`alice)(uid=*` becomes
`(uid=alice\29\28uid=\2a)` — a valid filter that matches nothing — instead
of collapsing the filter to match all users. Don't try to pre-escape on
the client; the server always escapes.

### Troubleshooting

- **503 / "LDAP is not available on this runtime"** — running on
  Cloudflare Workers. Move to Bun/Vercel/Netlify or use SAML SSO.
- **401 every time** — likely either the bind DN/password is wrong (check
  the *Test connection* dialog), or the `userFilter` doesn't match (try
  it against `ldapsearch -x -H <url> -D '<bindDn>' -W -b '<baseDn>'
  '(...your filter with the username...)'`).
- **Login succeeds but groups are empty** — the `memberOf` overlay isn't
  enabled (OpenLDAP) or the user really isn't in any groups. Run
  `ldapsearch ... '(uid=alice)' memberOf` to confirm.
- **`hostname-mismatch` / `unable to get issuer cert`** — the LDAPS cert
  chain isn't trusted by the host's CA store. Paste the issuing CA's PEM
  into *Custom CA PEM*.
