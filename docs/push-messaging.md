---
title: Push messaging
description: Native push (FCM / APNs / Web Push) with per-workspace providers, device registration, templates, and flow/sandbox fan-out.
---

Native push notifications to mobile and browser devices, alongside the in-app
[notifications feed](#in-app-vs-push). Push uses the **same adapter +
per-workspace config model as [email](/api-keys-and-email/)** — pick a provider,
store its credentials (encrypted at rest), and send.

## Providers

| Provider | Targets | Runtime notes |
|---|---|---|
| `fcm` | Android + cross-platform (and iOS/web via Firebase) | HTTP v1 API — works everywhere, including Cloudflare Workers. |
| `apns` | iOS native | Token-based (`.p8`). Direct APNs needs an **HTTP/2** runtime (Cloudflare Workers). On Node/Bun (HTTP/1.1) route iOS through `fcm` instead. |
| `web-push` | Browsers | VAPID + RFC 8291 `aes128gcm` encryption — works everywhere. |
| `console` | — | Dev only; logs the notification to stdout. |

All three real providers can be active at once: when several have credentials,
backlex composes them into one fan-out adapter and routes each device by its
`platform`.

## Configuration

Two layers, resolved in order (same as email): the workspace's own `push_config`
row → the instance-wide `_global` row → the deployment's `PUSH_*` env vars.

### Deployment env

```bash
# Force one provider, or leave unset to auto-compose every configured one.
PUSH_PROVIDER=            # fcm | apns | web-push | console

# Firebase Cloud Messaging (from the service-account JSON)
FCM_PROJECT_ID=my-app
FCM_CLIENT_EMAIL=firebase-adminsdk@my-app.iam.gserviceaccount.com
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"

# Apple Push (token-based .p8)
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=DEF456GHIJ
APNS_BUNDLE_ID=com.example.app
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"
APNS_PRODUCTION=true      # false → sandbox gateway

# Web Push (VAPID) — straight from `npx web-push generate-vapid-keys`
WEBPUSH_SUBJECT=mailto:admin@example.com
WEBPUSH_VAPID_PUBLIC_KEY=BPx…        # raw base64url public point
WEBPUSH_VAPID_PRIVATE_KEY=0jQ…       # raw base64url 32-byte scalar (NOT a PEM)
```

### Per-workspace (admin UI)

**Settings → Push** mirrors the Email tab: choose a provider, enter its config
and secret(s), and **Send test push** to your own registered devices. Secrets
are encrypted (AES-256-GCM, key derived from `AUTH_SECRET`) and never returned —
the form only shows a per-key "stored" flag.

## Device registration

A device registers itself through the authenticated end-user app. A device is
keyed by `(user, platform, token)`; re-registering the same token reactivates it
and refreshes `last_seen_at`, so clients can safely register on every launch.
Tokens the provider rejects as permanently gone (HTTP 404/410) are deactivated
automatically on the next send.

```ts
import { createClient } from "@backlex/client";
const client = createClient({ url: "https://api.example.com", token });

// FCM / APNs — token is the registration / device token
await client.messaging.registerDevice({ platform: "fcm", token: fcmToken, deviceName: "Pixel 9" });

// Web Push — pass the PushSubscription's endpoint + keys
const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
await client.messaging.registerDevice({
  platform: "web-push",
  token: sub.endpoint,
  keys: { p256dh: /* base64url */, auth: /* base64url */ },
});

await client.messaging.listDevices();
await client.messaging.unregister(deviceId);
```

REST equivalents: `POST /api/device-tokens`, `GET /api/device-tokens`,
`DELETE /api/device-tokens/{id}`.

## Sending

### From a flow

A `push` operation sends to one user's devices; `userId` may be a literal id or
a `{{ data.author }}` template:

```json
{ "type": "push", "userId": "{{ data.author }}", "title": "New reply", "body": "{{ data.preview }}", "url": "/posts/{{ data.postId }}" }
```

### From a function (sandbox)

```ts
await ctx.push.send({ userId: ctx.data.author, title: "Order shipped", body: "Track it now", url: "/orders/123" });
```

### Templates

Reusable `push_templates` (title/body/url with `{{ var }}` interpolation) are
managed under the admin API (`/api/admin/push-templates`) and rendered at send
time, same as email templates.

## In-app vs push

The [notifications feed](/service-map/) (`/api/notifications`) is the in-app
bell; push reaches the OS/browser. They compose — set `push: true` on a
notification (or on a flow `notification` op) to also fan out to the target
user's registered devices:

```json
{ "type": "notification", "userId": "{{ data.author }}", "title": "New reply", "push": true }
```

Push fan-out is best-effort: the in-app row always lands even if the device send
fails, and broadcasts (`userId: null`) never push (push needs a concrete
recipient with registered devices).

## Multi-tenant: each workspace brings its own keys

Unlike email, **there is no shared managed-push fallback** — and that's by
design, not an omission. A device push token is bound to the *app's own provider
project*: an FCM registration token only accepts sends from the same Firebase
project that minted it, and a web-push subscription only accepts sends signed by
the VAPID keypair the browser subscribed with. So a platform-wide key cannot
deliver to a tenant's users — every workspace must configure **its own**
FCM / APNs / VAPID credentials under **Settings → Push** (`push_config`).

Those per-workspace credentials are resolved and used **locally on the tenant's
worker** (secrets AES-encrypted at rest), so one workspace can never push to
another's devices — isolation holds at the device-registry level too (a send only
ever targets tokens from that workspace's own `device_tokens`).

The control-plane push gateway (`/api/internal/push/send`) exists for a future
*managed-push* offering where the platform provisions per-tenant credentials
centrally; it is unused unless platform `PUSH_*` vars are set, and a shared
platform key would only reach apps built under that same platform project.
