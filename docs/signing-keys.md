---
title: Signing keys
description: Rotate the key that signs your access tokens by promoting a standby key — not by editing a secret and redeploying twice.
---

Access tokens can be signed with [an asymmetric key](/docs/api-keys-and-email),
so anything else can verify a backlex token from
`/.well-known/jwks.json` without holding a shared secret.

That works until you have to **rotate**. By environment variable, rotation is:
edit a secret, deploy so verifiers learn the new public key, edit again, deploy
so it starts signing — and the only way back is a third deploy. Every one of
those steps happens in an incident, under time pressure.

Signing keys are rows instead, with four states and no irreversible transitions.

```bash
backlex signing-keys generate --note "2026 rotation"
# … give verifiers time to pick up the JWKS …
backlex signing-keys promote key_7f2c
```

## The states

| State | In the JWKS | Signs | Verifies |
|---|---|---|---|
| `standby` | yes | no | yes |
| `in_use` | yes | **yes** | yes |
| `previously_used` | yes | no | yes |
| `revoked` | no | no | **no** |

**`standby` is the whole point.** A verifier caches the JWKS, so a key that
started signing the moment it existed would mint tokens nobody could verify
until their cache expired. Generating always lands in `standby`, so the safe
order is not something anybody has to remember.

**Promoting demotes the incumbent in the same operation.** Two keys in `in_use`
would make "which one signs" a question about row order. And because the old key
becomes `previously_used` rather than disappearing, the tokens it already signed
keep working until they expire — and **rolling back is promoting it again**.

**Revoking is refused for the key in use.** Cascading would leave the instance
signing with nothing, which nobody asked for. Promote another key first.

**Deleting is only possible for a revoked key.** Anything else still verifies
tokens somebody is holding.

## The asymmetry that makes revocation useful

An external verifier reads the JWKS and caches it, so a revocation reaches them
whenever their cache expires — minutes, and not something backlex controls.

backlex's **own** verification does not read that document. It reads the rows,
behind a ten-second cache that any transition clears in the isolate that made
it. So a revoked key stops being accepted here within ten seconds while external
verifiers stay cache-fast.

Ten seconds is not zero, and a key revocation is a coarse instrument regardless:
it invalidates every token that key signed. To stop **one** session, revoke the
session.

## Moving off environment variables

Nothing changes until you create a key. With no rows, `AUTH_JWT_PRIVATE_KEY`
signs exactly as it did before this existed.

To migrate without invalidating a single live token:

```bash
backlex signing-keys import --file ./current-private-key.pem --note "was AUTH_JWT_PRIVATE_KEY"
backlex signing-keys promote <id>
```

The env key **keeps verifying** once rows take over signing — every token it
already minted is in somebody's hands, and its `exp` is the only thing that
should end it. Once those have expired, clear the env var.

## What is stored, and what is not

The private half is encrypted with the deployment's `AUTH_SECRET` — real
protection against a database dump, and none at all against someone who already
has the application's environment. That is the same trade the
[S3 credentials](/docs/s3) make, and the alternative is keys that can only ever
live in env.

No surface returns a private key, including `generate`. Unlike an API key,
nobody ever needs to hold it: it exists to sign, its public half is published,
and the only legitimate copy is the row.

`kid` is the RFC 7638 thumbprint of the public key — derived, never chosen, so
it is stable for a key and changes exactly when the key does.

Keys are **instance-level**, not per workspace: the JWKS is one document at one
URL and a token's `iss` names the instance.

## Surfaces

| Surface | Where |
|---|---|
| REST | `/api/admin/signing-keys` |
| SDK | `backlex.signingKeys.*` |
| MCP | `signing_keys.list/generate/promote/revoke/restore` |
| CLI | `backlex signing-keys …` |
