---
title: Outbound webhooks
description: HTTP delivery of collection events with HMAC signing, replay-safe signatures, durable retry, and an auto-disable circuit breaker.
---

A webhook POSTs a JSON payload to your endpoint whenever a matching event fires
(item created/updated/deleted, auth events, file events, …). Delivery is
**durable** — every dispatch is a `webhook.deliver` job, so a failing receiver
is retried with exponential backoff and dead-lettered rather than lost.

All webhook management is admin-only and workspace-scoped. The admin lives at
**Webhooks** in the sidebar; the API is under `/api/webhooks`.

## Subscribing

```http
POST /api/webhooks
{
  "name": "Slack #content",
  "url": "https://api.example.com/webhooks/backlex",
  "events": ["items.posts.created", "items.*.deleted"],
  "secret": "whsec_…",
  "headers": { "Authorization": "Bearer …" }    // optional custom headers
}
```

Event patterns support `*` wildcards per segment (`items.*.created` matches every
collection's create). The payload body is:

```json
{ "channel": "items", "event": "created", "data": { … }, "deliveredAt": "…" }
```

## Choosing what `data` carries

By default `data` is the whole row. A hook that only needs an id and a status to
kick off a job somewhere else is also handed the customer's address, the
internal note, and whatever column got added last week — to a third-party
endpoint, over the public internet, indefinitely, because nobody revisits a
webhook after it starts working.

`payloadFields` is a per-hook allow-list of top-level `data` keys:

```http
POST /api/webhooks
{
  "name": "Fulfilment",
  "url": "https://api.example.com/orders",
  "events": ["items.orders.created"],
  "payloadFields": ["id", "status", "updated_at"]
}
```

```json
{ "channel": "items", "event": "created",
  "data": { "id": "…", "status": "paid", "updated_at": "…" },
  "deliveredAt": "…" }
```

- **Omit it, or send `null`, for the whole row.** That is the default, so no
  existing hook changes shape.
- **An empty list also means the whole row**, not an empty body — a cleared list
  must not silently blank every delivery.
- **It is an allow-list, deliberately.** A field added to the collection next
  month does not start flowing to an endpoint that was configured before it
  existed; you add it when you mean to.
- **A listed key the row doesn't have is simply absent** — never an explicit
  `null`, which a receiver would read as "this was cleared".
- **Only the top level is projected.** A named object field is sent whole.
- Non-object payloads (system events whose `data` is an array or a scalar) pass
  through untouched — there are no keys to choose from.
- The body is built **per hook**, so two hooks on the same event can receive
  different payloads, and each signature covers the body that hook actually
  received.

Also on **Webhooks → edit → Fields to send** in the admin, `payloadFields` in
GraphQL and MCP, and `--fields id,status` on `backlex webhooks create`.

## Signing & verification

When a hook has a `secret`, every delivery is signed. Three headers travel with
each request:

| Header | Value |
|---|---|
| `X-Backlex-Timestamp` | Unix seconds when the delivery was signed. |
| `X-Backlex-Signature` | `HMAC-SHA256(secret, body)` — the legacy scheme. |
| `X-Backlex-Signature-V2` | `HMAC-SHA256(secret, "{timestamp}.{body}")` — **replay-safe**. |

Prefer **V2**: because the timestamp is part of the signed content, a receiver
can reject a captured-and-replayed request by checking that the timestamp is
recent. The legacy `X-Backlex-Signature` is still sent unchanged so existing
receivers keep working.

The SDK ships a constant-time verifier that runs anywhere Web Crypto is
available (Workers, Node 18+, Bun, Deno):

```ts
import { verifyWebhook } from "backlex/webhook";

// inside your receiver (raw body — do NOT re-stringify a parsed object):
const body = await req.text();
const ok = await verifyWebhook({
  secret: process.env.BACKLEX_WEBHOOK_SECRET!,
  body,
  signature: req.headers.get("x-backlex-signature-v2")!,
  timestamp: req.headers.get("x-backlex-timestamp")!,
  // toleranceSec: 300  // default; set 0 to disable the freshness check
});
if (!ok) return new Response("bad signature", { status: 401 });
```

Omitting `timestamp` falls back to verifying the legacy `X-Backlex-Signature`
over the bare body (no replay window). `verifyWebhook` returns `false` — never
throws — on any missing input, stale timestamp, or mismatch.

`Content-Type` and the `X-Backlex-*` headers are reserved; custom `headers` you
configure can't override them.

## Retry, replay & test

- **Retry** is automatic: a non-2xx (or a network failure) requeues the
  `webhook.deliver` job with exponential backoff until `maxAttempts`, then
  dead-letters. See [Job queue](/jobs).
- **Replay** a past delivery from the admin (or `POST
  /api/webhooks/_deliveries/{id}/retry`) — re-sends with the original headers +
  signature.
- **Test** fires a synthetic `webhook.test` event (`POST /api/webhooks/{id}/test`
  or the **Send test** button) so you can confirm DNS/auth without waiting for a
  real event.

The **Recent deliveries** panel shows status, latency, and event per attempt.

## Auto-disable (circuit breaker)

A dead endpoint shouldn't burn the queue forever. Each hook tracks
`consecutive_failures` — bumped on every failed delivery attempt, reset to `0`
on any 2xx. Once it crosses the threshold (15 consecutive failures) the hook is
**auto-disabled**:

- `active` flips to `false` and `disabled_reason` records why (surfaced as an
  **auto-disabled** badge on the Webhooks page).
- A broadcast notification is sent to admins, and an audit row
  (`webhook.auto_disabled`) is written.
- New events stop enqueuing and any in-flight job becomes a terminal no-op, so
  the receiver gets a break instead of an unbounded retry storm.

**Resume** clears the breaker: toggling the hook back to **active** (the Resume
action, or `PATCH /api/webhooks/{id}` with `{ "active": true }`) resets
`consecutive_failures` to `0` and clears `disabled_reason` for a clean slate.

`consecutiveFailures`, `lastFailureAt`, and `disabledReason` are returned on
every `GET /api/webhooks` row so you can monitor hook health programmatically.
