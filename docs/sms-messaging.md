---
title: SMS messaging
description: SMS (Twilio / Amazon SNS) with per-workspace providers, phone-number registration, and flow/MCP/SDK send paths.
---

Send SMS text messages to your users' phones. SMS uses the **same adapter +
per-workspace config model as [push](/push-messaging/) and
[email](/api-keys-and-email/)** — pick a provider, store its credentials
(encrypted at rest), and send.

## Providers

| Provider | Auth | Runtime notes |
|---|---|---|
| `twilio` | Account SID + Auth Token (HTTP Basic) | Programmable Messaging REST API — works on every runtime. Use a `From` number (E.164) **or** a Messaging Service SID. |
| `sns` | AWS access key + secret (SigV4) | Amazon SNS SMS (the transport behind AWS Amplify). Signed with Web Crypto — no AWS SDK. The IAM principal needs `sns:Publish`. |
| `console` | — | Dev only; logs the message to stdout. |

Unlike push (where one batch can span FCM/APNs/web-push), an SMS deployment uses
**exactly one provider** — there's no fan-out. When `SMS_PROVIDER` is unset the
first provider with complete credentials wins (`twilio` → `sns`).

## Configuration

Two layers, resolved in order (same as email/push): the workspace's own
`sms_config` row → the instance-wide `_global` row → the deployment's `SMS_*` /
`TWILIO_*` env vars.

### Deployment env

```bash
# Force one provider, or leave unset to auto-pick the first configured one.
SMS_PROVIDER=             # twilio | sns | console

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
import { createClient } from "@backlex/client";
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
[MCP tool reference](/mcp/).

### Templates / flows

SMS has no template table of its own yet; compose the body inline. (Push/email
templates are tracked separately.)

## In-app vs push vs SMS

- **In-app** (`/api/notifications`) — the bell feed inside the app.
- **Push** (`messaging.send_push`) — OS/browser notification; also drops an
  in-app row.
- **SMS** (`messaging.send_sms`) — a text message to the phone. Standalone: it
  does **not** create an in-app row.

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
