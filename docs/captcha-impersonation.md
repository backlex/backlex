---
title: Captcha & impersonation
description: A captcha in front of the endpoints a stranger can reach, and a way for support to see what a customer sees — recorded, time-capped and read-only by default.
---

Two things support and abuse-prevention need that rate limiting cannot give:
a way to ask whether there is a **person** on the other end, and a way to see
what a **specific customer** sees.

## Captcha

Rate limiting and [sign-in lockout](/docs/api-keys-and-email) already bound how
*fast* an attacker goes. Neither asks whether there is a person there at all —
which is what a public sign-up form, a password reset that mails a real person,
and a public [form](/docs/forms) submission all need.

```bash
backlex support captcha set \
  --provider turnstile \
  --site-key 0x4AAA... --secret 0x4AAA... \
  --protect sign-up,password-reset \
  --on-error deny
```

Turnstile, hCaptcha and reCAPTCHA are all supported; they agree on the wire
format, so the only thing that differs is which URL the verification goes to.

**What is protected is a list, not a switch.** The endpoints cost different
things: a sign-up creates a row, a password reset mails somebody who did not
ask, a form submission can be the abuse itself. Turning one on should not force
on the one that would break your own integration.

| Target | Covers |
|---|---|
| `sign-up` | password sign-up, magic link, and email OTP — all three end with a user existing who did not before |
| `sign-in` | password sign-in |
| `password-reset` | forget-password / request-password-reset |
| `forms` | public form submissions |

:::caution[`onError` has no default, deliberately]
A captcha that **fails open** protects nothing precisely when the provider is
having a bad day — which is a plausible thing for an attacker to arrange. A
captcha that **fails closed** turns the provider's outage into an outage of your
sign-up.

Neither is safe to choose on your behalf, so the API refuses to store a config
without an explicit `onError`.
:::

### On the client

The site key is published on the workspace's public auth surface
(`GET /api/t/<slug>/auth/providers`), because a sign-in screen cannot render the
widget without it and has nowhere else to get it. The secret and your `onError`
choice never appear there.

Send the widget's response as an `x-captcha-token` header, or as `captchaToken`
in the body:

```ts
await fetch("/api/t/acme/auth/sign-up/email", {
  method: "POST",
  headers: { "content-type": "application/json", "x-captcha-token": token },
  body: JSON.stringify({ email, password, name }),
});
```

The gate runs **in front of** the auth router, so a failed challenge costs
nothing downstream — no rate-limit budget, no lockout counter, no half-created
user.

The secret is stored encrypted with the deployment's `AUTH_SECRET` and has no
read-back path; the admin API reports it as present or absent.

## Impersonation

[`permissions.simulate`](/docs/permissions) answers "would this role be allowed
to do this". That is a static answer about a rule, and it is not the question
support gets asked. The question is *"why does my dashboard show nothing"*, and
answering it means seeing the application through that person's identity — their
org, their rows, their feature flags, their empty states.

```bash
backlex support impersonate usr_abc --reason "ticket #4821 — invoices list empty"
```

```
id          imp_7f2c…
acting as   ada@customer.example
mode        read-only
expires     2026-08-11T09:15:00.000Z
token       eyJhbGciOi…
```

Send that token as `Authorization: Bearer …` and every request resolves as the
customer: the same permissions, the same org context, the same row conditions.
Your own session is untouched — you hold two identities and choose which to
send, rather than having your session mutated into somebody else's.

### What makes it auditable rather than merely convenient

**The token names a row, and every request re-reads it.** A self-contained token
would be valid until it expired: "end this now" would have no meaning, and the
record of what happened would exist only if the operator chose to write it down.
One indexed lookup per impersonated request — paid only while somebody is
impersonating — buys instant revocation and a record that does not depend on
cooperation.

```bash
backlex support end imp_7f2c…   # takes effect on the very next request
```

**A reason is required.** An audit trail of who acted as whom, with no why,
answers the easy half of the question.

**Read-only by default.** Reproducing what a customer sees needs reads. Changing
their data on their behalf is a different act, and `--write` is how you say so.
A read-only session is refused every non-read action at the permission gate, so
there is no route that forgets to check.

**Capped at 60 minutes**, in code rather than config — an operator under
pressure picks the largest number the form allows. Asking for more is refused,
not clamped.

**App-plane subjects only.** One operator impersonating another is a privilege
move, not support. And an impersonated session cannot start another, so there is
no hop from a subject who happens to hold the admin role.

### The audit trail

```bash
backlex support impersonations
```

Every write made while impersonating carries the operator in the activity log's
`impersonated_by` column — a column, not a payload key, because *"what did
support do while acting as a customer"* is a query. `user_id` stays the
subject's: the write genuinely is theirs, which is what makes the reproduction
faithful, and a log that recorded only one of the two parties would answer the
wrong half of the question.

### Turning it off entirely

```
IMPERSONATION_DISABLED=1
```

The feature is admin-gated, audited and time-capped — but an operator who wants
it gone should not have to trust that nobody grants themselves the admin role.

## Surfaces

| Surface | Where |
|---|---|
| REST | `/api/admin/captcha`, `/api/admin/impersonation` |
| SDK | `backlex.support.captcha.*`, `backlex.support.impersonation.*` |
| MCP | `captcha.get/set/remove`, `support.impersonate`, `support.impersonations`, `support.end_impersonation` |
| CLI | `backlex support …` |
