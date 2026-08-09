---
title: Auth hooks
description: Run your own code at four moments in your end-users' authentication — admit a new user, put your claims in their access token, judge a password attempt, or send the mail yourself.
---

[Sync hooks](/docs/sync-hooks) let an external service participate in a **write**.
[Flows](/docs/flows) react to item, cron, manual and webhook events. Neither can
reach the moments that decide who an end-user *is*. Until auth hooks, nothing
could put `plan` or `tenant` into an access token, veto a sign-up on your own
rules, react to a password check, or deliver a sign-in mail through your own
transport.

An auth hook is your endpoint (or a [backlex function](/docs/sandbox)) called at
one of four moments:

| Moment | You are asked | You answer |
|---|---|---|
| `before-user-created` | a person is about to become an `app_users` row | `{ "allow": true }` / `{ "allow": false, "reason": "…" }` |
| `custom-access-token` | an access token is about to be signed | `{ "claims": { "plan": "pro" } }` |
| `password-verification` | a password sign-in just resolved | `{ "allow": true }` / `{ "allow": false, "reason": "…" }` |
| `send-email` | a magic link or one-time code is about to be mailed | `{ "handled": true }` (you sent it) / `{ "handled": false }` (we send it) |

```
POST https://your-app.example/auth-hook
webhook-id: msg_2f6e…
webhook-timestamp: 1817000000
webhook-signature: v1,K5oT…

{
  "event": "custom-access-token",
  "at": "2026-08-09T13:00:00.000Z",
  "tenantId": "…",
  "data": {
    "userId": "…",
    "email": "person@customer.example",
    "sessionId": "…",
    "roles": ["authenticated", "billing-admin"]
  }
}
```

```json
{ "claims": { "plan": "enterprise", "org": "acme", "seats": 12 } }
```

The next access token that workspace mints carries `plan`, `org` and `seats`,
and your API can authorize on them without asking backlex anything.

## Which plane these apply to

**Your workspace's end-users only** — the `app_users` pool behind
`/api/t/<workspace>/auth/*` ([auth planes](/docs/auth-planes)).

The platform plane — the people who administer this backlex instance — is
deliberately **not** hookable. On managed cloud a workspace admin is a customer,
and a hook there would let one customer observe and veto the operator sign-ins
of the instance they live on. There is no configuration that turns this on; the
`auth_hooks` table has no instance-wide row to write.

## One hook per moment

At most one hook per (workspace, event). Creating a second returns `409`.

Each event carries a different payload and a different verdict, so a hook
subscribed to several would have to implement four contracts — and two hooks
answering `custom-access-token` would fight over the same claim with no correct
answer about who wins. Chaining belongs in your own endpoint, where you can see
both rules at once.

## The decision you have to make: `onError`

`onError` is **required** and has no default, because neither answer is safe to
assume:

- **`deny`** — the auth action fails when your hook cannot answer. Your outage
  becomes a sign-in outage for your users.
- **`allow`** — the auth action proceeds without your hook's answer.

For `custom-access-token`, read `allow` carefully: it mints a token **missing**
the claim your authorizer reads, and an absent `plan` claim is the shape most
apps treat as "free tier" rather than "unknown". If your API fails open on a
missing claim, `allow` here is a privilege-escalation path in your own code.

A hook that is not reachable, times out, returns a non-2xx, or answers with
something that is not a JSON object counts as "cannot answer". A `200` with an
unreadable body is a **failure**, not an approval — otherwise a broken proxy in
front of your app would silently disable the gate.

## What a hook is allowed to put in a token

Reserved claims are **dropped**, never merged:

```
sub  tid  sid  plane  typ  iss  aud  exp  iat  nbf  jti  kid  alg  email
```

`sub`/`tid`/`sid`/`plane`/`typ` name the identity the API trusts; `exp`/`iat`/
`nbf` decide how long it lives; `iss`/`aud`/`jti`/`kid`/`alg` are what an
external verifier pins on. Each is a privilege boundary — a hook that could set
`tid` would be able to hand its own users a token for another workspace.

Two independent defences: the filter above, and the signer, which writes every
identity claim **over** the hook's, so a name that ever escapes the filter still
cannot decide who the token is for.

Claims are also capped at 2 KB serialized (the token travels in an
`Authorization` header on every request, so a kilobyte of profile is a cost
every request pays). Over the cap, the whole set is dropped rather than
truncated.

A dropped claim is silent at sign-in — it simply is not in the token. **Use
`test` to find out**: it reports exactly which returned claims would be dropped.

## Where each moment fires

**`before-user-created`** runs on every path that creates an `app_users` row:
email + password, social, magic link, one-time code, SAML, LDAP and a trusted
[third-party JWT](/docs/third-party-auth). A gate covering only self sign-up is
a gate somebody routes around by signing in with Google. It fires only when a
user is being **created** — an existing person signing in again is not a new
user, and re-admitting them on every login would make an unreachable hook an
outage for people you already approved.

**`custom-access-token`** runs whenever an access token is signed: at LDAP
sign-in, at invite acceptance, and on every `POST /api/t/<workspace>/auth/token/refresh`.
The claims are recomputed each time rather than carried forward from the
previous token — a 15-minute access token exists so that a plan change or a role
demotion is felt within the window, and copied claims would outlive both.

**`password-verification`** runs after `POST /api/t/<workspace>/auth/sign-in/email`,
with `valid: true` or `valid: false`. You hear about failures too, which is what
makes your own lockout, breach-list or impossible-travel logic possible.
Refusing a **correct** password is supported: the session backlex already
created is revoked before the `401` is returned, so the token in the discarded
response is dead. Only a decided credential check is reported — a malformed body
or an unverified-email refusal says nothing about the password and would poison
your counter.

**`send-email`** runs for magic-link and one-time-code mail. You receive the
*meaning* of the message — which mail, and the link or code it carries — not a
rendered body, because re-templating is the point. Under `onError: "allow"` an
unreachable hook falls back to the workspace's own transport rather than losing
the mail.

## URL targets, and function targets

A `url` target is called over HTTPS through the same SSRF guard every other
admin-supplied URL goes through.

A `function` target names a [backlex function](/docs/sandbox), run in the
sandbox with the payload as `ctx.data`; its return value is the verdict. No
network hop:

```js
// function: admission-gate
const domain = String(ctx.data.email).split("@")[1];
return domain === "customer.example"
  ? { allow: true }
  : { allow: false, reason: "Use your work email" };
```

This is what makes `custom-access-token` cheap enough to run on every token
mint, where a round trip is the dominant cost.

## Signing

A URL hook with a secret is signed with [Standard Webhooks](https://www.standardwebhooks.com):

| Header | Meaning |
|---|---|
| `webhook-id` | unique per delivery — also your idempotency key |
| `webhook-timestamp` | unix seconds; reject stale calls without parsing the signature |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` over `` `${id}.${timestamp}.${body}` `` |

The secret is `whsec_<base64 key>`. Every other outbound call backlex makes uses
its own `x-backlex-signature` scheme; this one deliberately does not, because an
auth hook is usually the first thing you implement against us and a
`standardwebhooks` verifier already exists in your language.

Verify it before trusting the body. Configured custom headers are applied
*before* the signing headers, so nothing you set can overwrite them.

## Timeouts and the breaker

Each hook has its own `timeoutMs` (default 2 s, hard max **5 s** — lower than a
sync hook's, because a person is watching a sign-in form with nothing else on
screen). After 15 consecutive failures a hook auto-disables and records why;
re-enabling it clears the counter.

## Managing hooks

Admin → **Settings → Auth**, or:

```bash
backlex auth-hooks list
backlex auth-hooks create --event custom-access-token \
  --url https://app.example/claims --on-error deny --secret whsec_…
backlex auth-hooks test <id>      # fires a representative payload
```

REST is `/api/admin/auth-hooks` (admin-only). The same surface exists over
GraphQL (`authHooks`, `createAuthHook`, …), the [SDK](/docs/sdk-and-cli)
(`client.authHooks`) and MCP (`auth_hooks.*`). Signing secrets are write-only on
every one of them — a listing reports `hasSecret`, never the value.

## Not hooked, and why

Two of the hook points other platforms offer have no equivalent here, because
backlex has nothing for them to intercept:

- **`send-sms`** — the workspace auth plane sends no SMS. [SMS](/docs/sms-messaging)
  exists, but only as a flow op and the messaging API; there is no phone-based
  sign-in for a hook to sit in front of.
- **`mfa-verification`** — the two-factor plugin runs on the platform (operator)
  plane only. Workspace end-users have no MFA enrolment to verify.

Both would be hook points that could never fire, which is worse than an
omission: an operator would configure one and believe it was running.
