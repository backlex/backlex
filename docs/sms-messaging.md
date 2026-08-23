---
title: SMS messaging
description: SMS (Twilio / Amazon SNS / NetGSM / İleti Merkezi) with per-workspace providers, phone-number registration, and flow/MCP/SDK send paths.
---

Send SMS text messages to your users' phones. SMS uses the **same adapter +
per-workspace config model as [push](/docs/push-messaging/) and
[email](/docs/api-keys-and-email/)** — pick a provider, store its credentials
(encrypted at rest), and send.

## Providers

| Provider | Auth | Runtime notes |
|---|---|---|
| `twilio` | Account SID + Auth Token (HTTP Basic) | Programmable Messaging REST API — works on every runtime. Use a `From` number (E.164) **or** a Messaging Service SID. |
| `sns` | AWS access key + secret (SigV4) | Amazon SNS SMS (the transport behind AWS Amplify). Signed with Web Crypto — no AWS SDK. The IAM principal needs `sns:Publish`. |
| `netgsm` | User code + panel password (query params) | NetGSM (Türkiye) over the classic HTTP GET API. Needs a NetGSM-approved message header (*başlık*) as the sender. |
| `iletimerkezi` | API key + hash (in the request envelope) | İleti Merkezi (Türkiye) over the v1 JSON API. Needs an approved sender title. |
| `console` | — | Dev only; logs the message to stdout. |

Unlike push (where one batch can span FCM/APNs/web-push), an SMS deployment uses
**exactly one provider** — there's no fan-out. When `SMS_PROVIDER` is unset the
first provider with complete credentials wins
(`twilio` → `sns` → `netgsm` → `iletimerkezi`).

All four adapters send **one HTTP request per recipient**, even where the
provider accepts a batch. Batch endpoints answer with a single status for the
whole order, which would make it impossible to tell *which* number was rejected —
and `invalidNumbers` (the array that deactivates rows in `phone_numbers`) has to
be exact. Only genuinely number-level rejections are mapped: NetGSM `70`
(invalid parameter on a single-recipient call) and İleti Merkezi `405` (invalid
recipient). Account-level failures — bad credentials, unapproved sender header,
no balance, rate limits — count as `failed` only, so one misconfiguration can
never wipe a workspace's phone book.

Both Turkish providers want the bare msisdn (`905321234567`); the adapters strip
the leading `+` from the stored E.164 number for you.

### Getting E.164 out of a collection

Every provider here requires E.164, and so does the `sms` flow op — a recipient
that does not match is refused before anything is sent. A `text` column of
numbers people typed will therefore fail row by row, at run time, long after the
write that caused it.

The fix is to make that column a **[phone field](./phone.md)**: every write is
canonicalized, and `backlex collections normalize-phones <slug> <field>` rewrites
the rows already there. Nothing is canonicalized inside the `sms` op on purpose —
a national number needs a region, and a flow has none to read, so guessing one
would text another country.

## Configuration

Two layers, resolved in order (same as email/push): the workspace's own
`sms_config` row → the instance-wide `_global` row → the deployment's `SMS_*` /
`TWILIO_*` env vars.

### Deployment env

```bash
# Force one provider, or leave unset to auto-pick the first configured one.
SMS_PROVIDER=             # twilio | sns | netgsm | iletimerkezi | console

# Twilio Programmable Messaging
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_FROM=+14155552671                 # E.164 sender, OR set the service SID below
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxx  # optional — a Messaging Service sender pool

# Amazon SNS SMS
SMS_AWS_REGION=us-east-1
SMS_AWS_ACCESS_KEY_ID=AKIA…
SMS_AWS_SECRET_ACCESS_KEY=…
SMS_AWS_SENDER_ID=MYAPP                   # optional, honoured only in some countries

# NetGSM (TR)
NETGSM_USERCODE=8501234567
NETGSM_PASSWORD=…
NETGSM_MSGHEADER=MYCOMPANY                # the sender header approved by NetGSM

# İleti Merkezi (TR)
ILETIMERKEZI_KEY=…
ILETIMERKEZI_HASH=…
ILETIMERKEZI_SENDER=MYCOMPANY             # the approved sender title
```

> The AWS vars are prefixed `SMS_` so they don't collide with any ambient
> `AWS_*` deploy variables.

### Per-workspace (admin UI)

**Settings → SMS** mirrors the Push tab: choose a provider, enter its config and
secret(s), and **Send test SMS** to a number you supply (or your account's
registered numbers). Secrets are encrypted (AES-256-GCM, key derived from
`AUTH_SECRET`) and never returned — the form only shows a per-key "stored" flag.

## Phone-number registration

A user registers a phone number through the authenticated end-user app. A number
is keyed by `(user, phoneNumber)`; re-registering reactivates it. Numbers the
provider rejects as permanently undeliverable are deactivated automatically on
the next send.

```ts
import { createClient } from "backlex";
const client = createClient({ url: "https://api.example.com", token });

await client.messaging.registerPhone({ phoneNumber: "+14155552671" }); // E.164
await client.messaging.listPhones();
await client.messaging.unregisterPhone(phoneId);
```

REST equivalents: `POST /api/phone-numbers`, `GET /api/phone-numbers`,
`DELETE /api/phone-numbers/{id}`.

## Sending

### REST

```bash
# Admins may target any user; non-admins only themselves. A user with no
# registered number is a silent no-op. Does NOT create an in-app notification.
POST /api/messaging/sms   { "userId": "u_123", "body": "Your code is 4821" }
```

### From the MCP server

The `messaging.send_sms` tool sends to one user's registered numbers — see the
[MCP tool reference](/docs/mcp/).

### From a flow

The [`sms` flow operation](/docs/flows/#who-an-sms-op-texts) turns any trigger into a
text message — the reason it exists is the reminder pattern, where a row landing
in a collection should text the person named on it:

```json
{
  "name": "Appointment reminder",
  "trigger": "event:items:appointments:created",
  "operations": [
    { "type": "delay", "durationMs": 82800000 },
    { "type": "sms", "to": "{{ data.phone }}",
      "body": "Reminder: your appointment is at {{ data.starts_at }}." }
  ]
}
```

Note the addressing: `to` sends to a number **carried on the row**, so the
recipient does not need a backlex account. Use `userId` instead when the target
*is* a platform user and you want their registered numbers. The op takes exactly
one of the two — see the flows guide for the validation rules.

### Templates

SMS has no template table of its own yet; compose the body inline. (Push/email
templates are tracked separately.)

## In-app vs push vs SMS

- **In-app** (`/api/notifications`) — the bell feed inside the app.
- **Push** (`messaging.send_push`) — OS/browser notification; also drops an
  in-app row.
- **SMS** (`messaging.send_sms`, or the `sms` flow op) — a text message to the
  phone. Standalone: it does **not** create an in-app row. The only one of the
  three that can reach someone without an account.

## Multi-tenant: cloud gateway

Unlike push (a device token is bound to the app's own provider project, so there
can be **no** shared platform fallback), an SMS destination is just a phone
number — any provider can reach it. So managed-cloud projects **do** get a shared
gateway: a provisioned tenant with no `SMS_*` vars routes its sends through the
control plane (`/api/internal/sms/send`, HMAC-signed), which delivers via the
platform's own Twilio / SNS credentials and throttles per project.

A per-workspace `sms_config` row always takes precedence — the gateway is only
the fallback used when nothing else is configured. Self-hosted / OSS installs
never reach it (the cloud vars are absent), so SMS there always goes direct
through the workspace's or deployment's own credentials.
