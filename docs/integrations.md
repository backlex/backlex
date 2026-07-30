---
title: Integrations
description: Connect Slack, Jira, Algolia and a dozen more providers; fan record events out to them, call them from flows, and watch delivery health with a log and a circuit breaker.
---

An integration connects one workspace to one third-party provider. Record
events fan out to it automatically, and flows can send through it on demand.
Delivery is **durable** — every dispatch is an `integration.deliver` job, so a
failing provider is retried with backoff and dead-lettered rather than lost.

Management is admin-only and workspace-scoped. The admin lives at
**Integrations** in the sidebar; the API is under `/api/admin/integrations`.

:::note
Integrations are *outbound and credentialed*: you paste a provider credential,
backlex encrypts it at rest, and it is never readable again. That is the
difference from [outbound webhooks](/docs/webhooks/), where you own the
receiving endpoint and backlex signs what it sends.
:::

## Providers

Eighteen providers ship in the registry, grouped by category:

| Category | Providers |
|---|---|
| chat | Slack, Discord, Microsoft Teams, Telegram |
| observability | Datadog, Sentry, PagerDuty, Opsgenie |
| analytics | PostHog, Segment |
| issue tracking | GitHub, Linear, Jira |
| search | Algolia, Meilisearch, Typesense, Elasticsearch / OpenSearch |
| productivity | Notion *(OAuth)* |

Each provider declares its own config fields, so the connect dialog and the CLI
are generated from the registry rather than hand-maintained. Read the catalog to
learn what a provider needs:

```bash
backlex integrations catalog          # every provider
backlex integrations catalog jira     # just Jira's fields
```

Fields marked `secret` are encrypted at rest with `AUTH_SECRET` and masked on
every read, across every surface.

## Connecting

One row per `(workspace, provider)` — connecting the same provider twice
reconfigures it rather than creating a second row.

```bash
backlex integrations connect --kind slack \
  --set webhookUrl=https://hooks.slack.com/services/… \
  --events 'orders.*,invoices.created'
```

`--events` scopes which record events reach the provider. Patterns are
`<collection>.<action>` and support `*` and `prefix.*`; omit it for **all**
events.

## Connecting with OAuth

Some providers are connected by redirect rather than by pasting a key. They are
flagged `oauth` in the catalog:

```bash
backlex integrations catalog        # oauth=yes column, plus the redirect URI
```

backlex is self-hostable, so there is no platform OAuth client to fall back on —
**each workspace registers its own app** with the provider. Three steps:

1. Create an OAuth app at the provider and register the redirect URI that
   `integrations catalog` prints. It is derived from `APP_URL` server-side; do
   not retype it from the browser's address bar, because behind a proxy the two
   differ and the provider rejects the mismatch.
2. Save the client credentials. This does **not** connect the account:

   ```bash
   backlex integrations connect --kind notion \
     --set clientId=… --set clientSecret=… --set pageId=…
   ```

   The card shows **Not authorized** at this point and nothing is delivered.
3. Authorize. In the admin UI this is the **Authorize** button; elsewhere:

   ```bash
   backlex integrations authorize <integration-id>   # prints a link to open
   ```

   The link is single-use, expires in 10 minutes, and only completes in a
   browser already signed in as the same admin who asked for it.

### What the flow guarantees

| | |
|---|---|
| `state` | Random, never stored — only its SHA-256 is, so reading the database cannot complete a pending authorization |
| Single use | The state row is consumed with `DELETE … RETURNING`, so two concurrent callbacks cannot both proceed |
| Session binding | The row pins the workspace *and* the admin; a code redeemed from another session or another workspace is refused |
| `redirect_uri` | Derived from `APP_URL`, never from the request host, and replayed at exchange time |
| PKCE | Sent (S256) for every provider that supports it |
| Tokens | Written only by the flow, under reserved `_oauth*` config keys that admin writes are stripped of, encrypted at rest and masked on read |

Access tokens are renewed automatically ahead of expiry. If the grant is revoked
at the provider, delivery reports *"OAuth connection needs re-authorizing"* and
stops rather than retrying — use **Reauthorize** to reconnect.

Failures on the callback all land on one message on purpose: telling an unknown
state apart from an expired or already-used one would confirm to a prober which
values were ever real.

## What gets sent

For a record event, the provider receives a one-line human `text` and a machine
`payload`:

```json
{
  "event": "orders.created",
  "text": "orders: record created #A-42",
  "payload": { "collection": "orders", "event": "created", "id": "A-42" }
}
```

Chat providers render `text`; structured providers (GitHub dispatch, Algolia,
Meilisearch, Typesense, Elasticsearch, Segment) consume `payload`. **Field values are never included** —
the payload carries the collection, the action and the record id, so a chat
channel never becomes an unaudited copy of your data.

## Delivery health

Every attempt — including queue retries — is recorded:

```bash
backlex integrations deliveries <id> --limit 20
```

| Column | Meaning |
|---|---|
| `status` | HTTP status; **0** means the provider was misconfigured or unreachable |
| `ms` | round-trip duration |
| `attempts` | the queue's attempt counter (1 = first try) |
| `error` | `HTTP 4xx/5xx`, or `provider misconfigured or unreachable` |

Response bodies are deliberately **not** stored. Unlike a webhook receiver you
own, these are credentialed third-party APIs whose error bodies routinely echo
the token back.

### The circuit breaker

Consecutive failures accumulate on the integration; any success resets the
counter. After **15** consecutive failures the integration flips to `disabled`
with a reason, and dispatch stops selecting it. Fix the config, then:

```bash
backlex integrations resume <id>
```

The admin shows the same thing: a **Paused** badge with the reason, and a
**Resume** button next to **Deliveries**.

## Calling an integration from a flow

The `integration` operation turns every connected provider into a flow step.
The flow names the *provider*, never a row id or a credential — the workspace's
row is resolved at run time:

```json
{
  "type": "integration",
  "kind": "slack",
  "text": "Order {{ data.id }} shipped to {{ data.city }}",
  "event": "order.shipped",
  "payload": { "id": "{{ data.id }}" }
}
```

`text` and `payload` interpolate the trigger payload. `event` is the label the
delivery log records (default `flow.run`).

A provider the workspace hasn't connected — or one the breaker has paused — is
**skipped**, not failed: an integration outage must not take the automation down
with it. A provider that *is* connected and returns a non-2xx does fail the
step, so `onError` runs.

In the flow builder this is the **Integration message** action; the provider
dropdown lists what the workspace has connected.

## Surfaces

| Surface | Entry point |
|---|---|
| REST | `/api/admin/integrations` (+ `/catalog`, `/{id}/deliveries`, `/{id}/resume`, `/{id}/oauth/authorize`) |
| SDK | `client.integrations.*` |
| GraphQL | `integrationCatalog`, `integrations`, `integrationDeliveries`, `connectIntegration`, `resumeIntegration`, `disconnectIntegration`, `startIntegrationOAuth` |
| MCP | `integrations.catalog` / `.list` / `.connect` / `.deliveries` / `.resume` / `.disconnect` / `.oauth_authorize` |
| CLI | `backlex integrations …` |

`/api/admin/integrations/oauth/callback` is the provider's redirect target. It
is not part of the API you call: it always answers with a redirect into the
admin UI, because the caller is a browser mid-navigation.

All five funnel through one service, so the tenant guards, the encryption at
rest and the breaker are shared rather than restated per surface.

## Adding a provider

Providers live one-per-file under `packages/integrations/src/providers/`:

```ts
import { defineProvider } from "../provider";

export const acme = defineProvider({
  id: "acme",
  label: "Acme",
  category: "chat",
  capabilities: ["sink"],
  configFields: [
    { key: "token", label: "API token", secret: true },
    { key: "room", label: "Room" },
  ],
  async deliver(ctx) {
    const token = ctx.str("token");
    const room = ctx.str("room");
    if (!token || !room) return null;          // misconfigured → logged, never thrown
    return ctx.post("https://api.acme.test/post", { room, text: ctx.event.text },
      { Authorization: `Bearer ${token}` });
  },
});
```

Register it in `providers/index.ts` and add its id to `INTEGRATION_KINDS`. That
tuple stays hand-written because it sources the `IntegrationKind` literal union;
`PROVIDERS` is typed `Record<IntegrationKind, …>`, so adding one without the
other is a compile error.

`SECRET_KEYS` is **derived** from the fields you mark `secret` — there is no
second table to keep in sync, and a field marked secret cannot be missed by
encryption at rest.

For an OAuth provider, add an `oauth` block and declare `clientId` +
`clientSecret` as ordinary fields:

```ts
oauth: {
  authorizeUrl: "https://acme.test/oauth/authorize",
  tokenUrl: "https://acme.test/oauth/token",
  scopes: ["records:write"],
  authorizeParams: { access_type: "offline", prompt: "consent" }, // or no refresh token is issued
  pkce: true,
  tokenAuth: "body",              // "basic" when the provider rejects body credentials
  keepFromTokenResponse: ["realmId"],
},
```

Both endpoints must be fixed constants. The two token keys are added to
`SECRET_KEYS` automatically — a provider author never lists them, and deriving
them is what stops an access token coming back in cleartext.

Returning `null` from `deliver` marks the integration misconfigured; any throw
is caught. A broken provider can never break the write path that fired the
event.
