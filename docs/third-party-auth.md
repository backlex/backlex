---
title: Third-party auth
description: Accept JWTs minted by Clerk, Auth0, Firebase Auth, AWS Cognito or WorkOS as they are — no user migration, no second login.
---

An app that already signs its users in somewhere else can call Backlex with
**the token it already holds**. Backlex verifies the signature against the
issuer's published keys and maps the subject onto a workspace end-user.

This is the shortest path from "we're on Clerk" to "we're on Clerk *and*
Backlex". Nothing is migrated and nobody signs in twice.

## Not the same thing as SSO

Backlex has three federation surfaces and they answer different questions.
Picking the wrong one costs a week, so the distinction is worth thirty seconds:

| | Who starts the flow | What Backlex needs | What the user experiences |
|---|---|---|---|
| **SAML / OIDC SSO** ([sso.md](/docs/sso/)) | Backlex redirects to the IdP | A client secret / signing cert | A second sign-in, then a Backlex session |
| **Third-party auth** (this page) | Nobody — the app already has a token | Only the issuer's **public** keys | Nothing. Their existing session just works |
| **SCIM** ([sso.md](/docs/sso/)) | The IdP, on its own schedule | A bearer token you issue | Accounts appear and disappear without anyone logging in |

The practical tell: if your frontend can already call `getToken()` and get a
JWT, you want this page. If you need a "Sign in with…" button, you want SSO.

## Wiring one up

**Admin → Settings → Authentication → Third-party auth → Trust issuer.**

Pick your vendor from the list and the issuer + discovery URL are pre-filled in
the right shape; you fill in your own subdomain or project id.

| Field | What it is |
|---|---|
| **Issuer** | The `iss` claim, character for character. Auth0's ends with a slash, Clerk's does not — copy it from a real token, not from a dashboard URL. |
| **Discovery URL** | `.well-known/openid-configuration`. Read **once, at save time**, to resolve the signing-key endpoint; the request path never re-resolves it. |
| **JWKS URL** | Only needed when the issuer publishes no discovery document. |
| **Audience** | Expected `aud`. Leave blank only when the issuer serves this workspace alone — one IdP shared by several apps needs it set. |
| **Subject / email / groups claim** | Where to read the stable id, the address, and group membership. Dotted paths work (`user.email`). |
| **Default role / groups → roles** | Same mapping the SAML and OIDC paths use. |
| **Create accounts on first sight** | On by default. Turn it off when SCIM owns the user lifecycle — unknown subjects are then refused rather than provisioned. |
| **Link by email** | Attach to an existing end-user with the same address. Off by default: an issuer that does not verify emails would make this an account-takeover path. |

Then just send the token:

```ts
const token = await clerk.session.getToken();

await fetch("https://api.example.com/api/items/posts", {
  headers: { authorization: `Bearer ${token}` },
});
```

No `workspace` header, no Backlex sign-in call. The token's issuer is what
names the workspace.

### Checking a token

Every saved issuer has a **Test a token** box. Paste a real token and it
reports what the claim mapping extracted — or precisely why it was refused.
Nothing is provisioned and no session is created. The same thing over MCP:

```
third_party_auth.providers_test { id, token }
```

## What is enforced

A token is accepted only when **all** of these hold:

- **Asymmetric signature with a `kid`.** RS256/384/512, PS256/384/512,
  ES256/384/512. A symmetric (`HS*`) token is refused outright: verifying one
  requires a secret that also *mints* one, so a leak on either side would forge
  identities on both.
- **The key is in the issuer's published JWKS.** Fetched over HTTPS, cached for
  ten minutes. An unknown `kid` triggers at most one refetch every 30 seconds —
  without that floor, a stream of made-up `kid`s becomes a stream of outbound
  requests aimed at your IdP, paid for by you.
- **`exp` is present and unexpired**, within a 60-second clock allowance. A
  token with no expiry is refused: it would be a credential nothing could
  revoke.
- **`nbf`**, when present.
- **`aud` matches**, when the provider configures one. A string or an array,
  per RFC 7519.
- **The issuer is registered and enabled** on this instance.

Everything that follows — subject, email, groups — is read only after the
signature verifies.

### The issuer names the workspace

A request carrying one of these tokens has no session row and no workspace
header to lean on. The `iss` claim is the only thing that can say which
workspace it belongs to, which is why **an issuer can be registered once per
instance**. An `X-Backlex-Tenant` header cannot move such a request elsewhere.

In practice this constrains nothing: real issuers are already
customer-specific — `https://acme.clerk.accounts.dev`,
`https://securetoken.google.com/my-project`, `https://acme.auth0.com/`.

### Revocation belongs to the issuer

There is no `app_sessions` row behind these requests, so there is nothing on
the Backlex side to revoke — sign-out, session invalidation and token lifetime
are the IdP's job. What Backlex controls:

- **Suspending the end-user** blocks them immediately, however valid their
  token.
- **Disabling or deleting the issuer** stops every token from it at once.
- The required `exp` bounds how long anything survives an IdP-side revocation.

Deleting an issuer keeps the `external_identities` links, so re-adding the same
issuer restores access to the same people rather than provisioning duplicates.

## Users, roles and cost

The first token from a new subject provisions an `app_users` row and links it
through `external_identities` with `provider_type = 'jwt'` — the same store
SAML and LDAP use. It is a normal workspace end-user from then on: roles,
permission DSL, organizations, everything.

An email claim is **required to provision**, because `app_users.email` is
NOT NULL. A token without one is refused rather than given a placeholder
address that would later collide or be emailed.

Because these requests carry no session, every one of them is a fresh identity
assertion. Re-running provisioning on each would mean five or six queries per
API call, so a linked identity is re-reconciled at most **once every five
minutes** (stamped on `external_identities.last_login_at`). Steady-state cost
is one indexed query; a group changed at the IdP lands within that window.

## API

`/api/admin/third-party-auth/providers` — admin-only, scoped to the active
workspace.

| Method | Path | |
|---|---|---|
| GET | `/providers` | list |
| POST | `/providers` | create — resolves `jwks_uri` from `discoveryUrl` |
| PATCH | `/providers/{id}` | partial update |
| DELETE | `/providers/{id}` | stop trusting (identity links are kept) |
| POST | `/providers/{id}/test` | verify a pasted token, provision nothing |

MCP: `third_party_auth.providers_list` / `_create` / `_update` / `_delete` /
`_test`.

## Related

- [Auth planes](/docs/auth-planes/) — where workspace end-users live, and the
  access-token model this rides alongside
- [SSO (SAML, OIDC & LDAP)](/docs/sso/) — the redirect-based flows
- [API keys, access tokens, email & OAuth](/docs/api-keys-and-email/) — the
  other bearer shapes the same middleware accepts
