---
title: OAuth provider
description: The authorization server backlex already runs — discoverable, with a client registry, an off switch for open registration, and grants you can take back.
---

backlex runs a full OAuth 2.1 / OIDC authorization server. It was built for the
[MCP connector](/docs/mcp) — hosted agents like claude.ai obtain a token through
it rather than pasting an API key — and everything the spec needs is there:
PKCE, a consent screen, refresh tokens, discovery, dynamic client registration.

What it did not have was anyone able to *see* it. Clients arrived only by
dynamic registration, nothing listed them, nothing could disable one, and the
consents a person had granted were invisible to both them and the operator.

That is the difference between running an authorization server and operating
one.

## Discovery

```
/.well-known/openid-configuration
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
```

The first two are the same document. OIDC libraries look for
`openid-configuration`; OAuth 2.1 clients look for
`oauth-authorization-server`. Serving only the second meant a library that
speaks OIDC could not discover this server at all.

## The client registry

```bash
backlex oauth clients
backlex oauth register --name "Reporting portal" \
  --redirect https://portal.example.com/callback --confidential
```

| Field | Notes |
|---|---|
| `type` | `public` (PKCE, **no secret**) or `confidential` (holds a secret) |
| `redirectUrls` | https, or http on loopback for a native app. No fragments. |
| `dynamic` | true when the client registered itself — nobody vetted those |
| `disabled` | stops the client immediately, keeps its history |

**A public client gets no secret.** PKCE is what protects it, and a secret
shipped in a browser or a CLI is not a secret — issuing one would only
encourage somebody to rely on it. A confidential client's secret is shown once,
and stored as issued because the token endpoint has to compare against it.

**Disabling is not deleting.** A disabled client stops working and its history
stays: which tokens it holds, who consented, when. Deleting cascades all of that
away, which is right for a client registered by mistake and wrong for one that
misbehaved — there, the history is the evidence.

## Turning open registration off

```
OAUTH_DYNAMIC_REGISTRATION=off
```

On by default, and that is not laziness: the hosted MCP connectors this server
exists for register dynamically, so defaulting it off would break the one client
everybody actually uses. An instance run as a company identity provider wants
the opposite — with it off, `/api/auth/mcp/register` answers RFC 7591's
`access_denied` and the registry is the only way in.

## Grants, and taking one back

```bash
backlex oauth grants --user usr_abc
backlex oauth revoke --client blx_… --user usr_abc
```

Revoking deletes the consent **and every token issued under it**. Removing only
the consent would be a revocation that does not revoke: the access token keeps
working until it expires and the refresh token keeps minting more. The person
pressing "remove access" means both.

## A token from this server only works on the MCP endpoint

**This is a behaviour change.** A token minted here is a credential for one
resource, and using it anywhere else is refused with `403 FORBIDDEN`:

```
This access token is scoped to the MCP endpoint.
Use an API key (`pak_…`) for the REST and GraphQL API.
```

`/.well-known/oauth-protected-resource/mcp` has always advertised
`resource: <APP_URL>/mcp` — RFC 9728, the identifier a strict client compares
against the server URL it was pointed at — and the consent screen says "MCP
connector". The server now enforces what it publishes.

Before, it did not. The grant's scopes were read exactly once, to decide
read-only *inside* the MCP dispatcher, so a token granted `openid mcp:read`
was refused a write over `/mcp` and in the same breath created collections,
inserted rows and ran arbitrary SQL through `/api/…`. Anything the consenting
user could do, the token could do, on every surface, with none of the controls
an API key carries — no per-key revocation, no tenant pin, no role scoping, no
rate limit, no quota.

Two consequences worth knowing before you upgrade:

- **A grant carrying neither `mcp:read` nor `mcp:write` no longer reaches
  `/mcp` at all.** It used to get full MCP read — the advertised scopes were
  optional decoration on the way in. Re-authorize such a client asking for one.
- **Scripts that reused an MCP token against the REST API must move to an API
  key.** `backlex apikeys create` mints one; that is the credential the REST
  and GraphQL surfaces are designed around.

The discovery documents under `/.well-known/` are exempt, deliberately: they
answer anonymous callers anyway, so refusing them would guard nothing while
breaking a client that re-reads its metadata with the bearer still attached.

Nothing else changes. `mcp:write` still decides writes at the resource, the
`openid` / `profile` / `email` / `offline_access` scopes are still consumed by
this server's own `/api/auth/*` endpoints, and every other credential shape —
cookie session, `pak_` API key, app-plane access token, third-party JWT — is
untouched. MCP tools themselves keep working: they do their work by re-entering
this same app on `/api/…` paths, and those calls are recognised by object
identity rather than by anything a caller can send.

## What this deliberately is not

**A per-workspace identity provider over your end-users** — "sign in with *your*
app". It was checked against the code rather than assumed, and the blocker is
concrete: an authorization endpoint has to be able to send an *unauthenticated*
person somewhere to sign in, and backlex does not host a sign-in page for a
workspace's end-users. Your application does. Building it would mean either
hosting a login page per workspace on our domain, or defining a callback
protocol into yours — a different feature with a different shape, not "the rest
of this one".

[Third-party auth](/docs/third-party-auth) already covers the direction
customers actually ask for: your existing identity provider, our API.

## Surfaces

| Surface | Where |
|---|---|
| OAuth | `/.well-known/*`, `/api/auth/mcp/{authorize,token,register}`, `/oauth/consent` |
| REST | `/api/admin/oauth-clients`, `/api/admin/oauth-clients/grants` |
| SDK | `backlex.oauth.*` |
| MCP | `oauth.clients`, `oauth.register`, `oauth.set_disabled`, `oauth.grants`, `oauth.revoke_grant` |
| CLI | `backlex oauth …` |
