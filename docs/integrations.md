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

Thirty-one providers ship in the registry, grouped by category:

| Category | Providers |
|---|---|
| chat | Slack, Discord, Microsoft Teams, Telegram, Google Chat |
| observability | Datadog, Sentry, PagerDuty, Opsgenie |
| analytics | PostHog, Segment, Mixpanel, Amplitude |
| issue tracking | GitHub, Linear, Jira |
| search | Algolia, Meilisearch, Typesense, Elasticsearch / OpenSearch |
| productivity | Notion, Google Sheets, Google Drive, Google Calendar *(OAuth)*, Airtable *(OAuth)*, Contentful — all sources |
| accounting | QuickBooks Online, Xero — both *(OAuth)*, both sources |
| warehouse | ClickHouse, Google BigQuery — both *destinations* |
| crm | HubSpot — *receives record contents*, see below |

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

## Pulling data in

A **source** provider goes the other way: it reads rows from the external system
into one of your collections on a schedule.

Rows land in an **ordinary collection**, not a system table, so everything the
platform already does applies to them for free — the permission DSL, REST and
GraphQL querying, realtime, revisions, exports, the BI panels.

```bash
backlex integrations sync-create --integration <id> --collection leads \
  --set spreadsheetId=1AbC… --set sheetName=Sheet1 \
  --map Name=name --map Email=email \
  --every 30

backlex integrations sync-run <sync-id>   # pull now, see what landed
backlex integrations syncs                # schedules + health
```

- `--set` keys come from the catalog's `sourceSettings` for that provider.
  Anything else is **rejected**, not forwarded — settings end up in URLs.
- A setting with a `values` column in `integrations catalog <kind>` is a **closed
  set** (QuickBooks' record type, Xero's endpoint). The admin UI renders those as
  a picker, and anything outside the list is refused.
- `--map` is `ExternalField=collection_field`. Every target must be a writable
  field on the collection; an unknown one is refused rather than silently
  dropped, which would report a clean run while losing a column every time.
- The collection must be **managed**. An adopted table already owns its data.
- `--every 0` makes the sync manual-only.

### How rows are identified

A pulled row's primary key is `<provider>_<sync-prefix>_<external-id>`, e.g.
`airtable_9f3c1a20_recAbC123`. That namespacing is what makes it safe to aim a
sync at a collection that already holds data:

- re-pulling **updates in place** instead of duplicating,
- a row **a person created** can never be overwritten,
- **two syncs** into the same collection cannot collide, even when both number
  their rows from 1.

The three connectors differ in exactly one way that matters. Airtable and Notion
give every record a stable id, so a row that moves stays the same record. Sheets
has no row id, so the **row number** is the identity — moving a row there reads
as a different record.

### Accounting sources

QuickBooks and Xero each need one thing beyond an access token, and they get it
differently:

- **QuickBooks** returns the company id as `?realmId=…` on the *redirect* and
  nowhere in the token response. The descriptor names it in
  `keepFromCallbackQuery`, so the connect flow captures it. Its refresh token
  rotates on every renewal, which is why the refresh path is a compare-and-set.
- **Xero** needs an `Xero-Tenant-Id` header naming which organisation to read,
  discoverable only by calling `/connections` after authorizing. The connector
  resolves it at the start of each run — one small request against a page budget
  of twenty, which beats adding a post-connect hook for a single provider and
  cannot go stale when the admin changes what they granted. Leave
  **Organisation** blank to use the first one granted.

Both are read-only: the scopes requested cover reading, not writing. Mirroring
accounting data in is the case people ask for; pushing entries back out is a
different feature with different failure modes.

## Mirroring a collection out

A **destination** is the other direction: rows leave a collection for a
warehouse, on the same schedule, breaker and mapping machinery as a pull. One
table backs both — only the direction of travel differs.

```bash
backlex integrations sync-create --integration <id> --collection leads \
  --direction push --set table=leads \
  --map name=customer_name --map email=customer_email --every 60
```

The mapping is read **in the direction of travel**: `external → field` on a pull,
`field → external column` on a push.

The row's **primary key always travels**, whatever the mapping says. That is what
makes a re-sent batch an upsert rather than a duplicate — ClickHouse collapses it
on merge (the target should be a `ReplacingMergeTree` ordered by `id`), BigQuery
de-duplicates on `insertId`.

### The watermark

A push resumes from `<updated_at>|<id>`, and the pairing is load-bearing:

- `updated_at > last` alone **skips** every row sharing the last one's timestamp,
  forever, because the watermark never moves past them.
- `updated_at >= last` **re-sends** the last row on every run.

The watermark advances only **after** the push resolves, so a failed batch is
retried rather than skipped. A collection with no `updated_at` column is refused
outright — there is no total order to resume from.

### What a push cannot do

**Hard deletes are invisible.** A watermark walk only ever sees rows that still
exist. Use a soft-delete collection if the warehouse needs to know: a tombstone
is an update and travels like any other row.

### The target table

backlex does not create it. Creating tables needs privileges an insert-only
credential should not have, and partitioning, ordering and TTL are decisions the
cluster owner should make rather than have guessed. Run the DDL once —
`backlex integrations catalog <kind>` prints a starting point.

### Two kinds of resume

Most sources page to the end and then start over, so the next run notices edits.
A few hand back a marker that makes the next run **incremental** — and that is a
different thing from a page cursor:

| | Means |
|---|---|
| `cursor` | more pages in **this** run |
| `resumeToken` | this run is done; begin **here** next time |

Google Calendar is the example. Its `nextSyncToken` returns only what changed
since the last run — including **cancellations**, which a page walk never sees.
Returning it as a cursor would leave the engine believing there is another page
and it would ask forever, so the two are separate fields.

A stale sync token gets a `410` from Google, and the only recovery is a full
re-read: clear the sync's settings, which resets the cursor.

### Runs, cursors and failure

A run is bounded to 20 pages / 2000 rows. If the provider still has more, the
cursor is kept and the next run resumes there — a mid-cursor sync is due
immediately rather than waiting out its interval, so a large first import does
not take days.

A failed page **does not advance the cursor**: those rows are re-read on the next
attempt rather than skipped. A run where the collection rejected a row fails
loudly for the same reason — reporting success would move past data nobody
stored. Five consecutive failures pause the sync with the reason on the row;
re-enabling clears the counter.

If the OAuth grant is revoked, the run reports *"needs re-authorizing"* and stops
instead of retrying something no retry can fix.

## What a sink receives

By default a sink is told that something **changed**, not what it **said**:

```json
{ "collection": "orders", "event": "created", "id": "ord_123" }
```

That is deliberate. Handing every connected chat channel the contents of every
row is not a default anyone would choose, and most sinks — chat, alerting,
analytics — only need the event.

A provider that genuinely needs the row declares `recordPayload`, and then:

- the record is attached **only** to that provider's message,
- it is scoped **before the queue row is written**, so row contents never park in
  the jobs table for a provider that will not use them,
- it is re-checked **before it reaches a provider**, so a job written by hand
  cannot smuggle one through,
- the connect dialog **says so before you connect**, and the event filter is how
  you scope which collections that applies to.

**HubSpot** is the only provider that asks for it today: a CRM cannot upsert a
contact from an id alone. It keys the upsert on `email`, so the queue's retries
update the same contact rather than creating a second one.

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
| REST | `/api/admin/integrations` (+ `/catalog`, `/syncs`, `/{id}/deliveries`, `/{id}/resume`, `/{id}/oauth/authorize`) |
| SDK | `client.integrations.*` |
| GraphQL | `integrationCatalog`, `integrations`, `integrationSyncs`, `integrationDeliveries`, `connectIntegration`, `resumeIntegration`, `disconnectIntegration`, `startIntegrationOAuth`, `createIntegrationSync`, `updateIntegrationSync`, `deleteIntegrationSync`, `runIntegrationSync` |
| MCP | `integrations.catalog` / `.list` / `.connect` / `.deliveries` / `.resume` / `.disconnect` / `.oauth_authorize` / `.syncs` / `.create_sync` / `.update_sync` / `.delete_sync` / `.run_sync` |
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
  tokenAuth: "body",                    // "basic" when the provider rejects body credentials
  keepFromTokenResponse: ["workspace_name"],
  keepFromCallbackQuery: ["realmId"],   // for values that arrive on the redirect only
},
```

`keepFromCallbackQuery` reads a third party's redirect, so only the keys named
here are kept, they are stored as opaque strings, and they are length-capped.

Give a setting `options` when it has a closed set of values — anything a provider
interpolates into a URL path or query string should be one:

```ts
settingFields: [{ key: "entity", label: "Record type", options: [
  { value: "Customer", label: "Customers" },
  { value: "Invoice", label: "Invoices" },
]}],
```

The UI renders a picker and the engine refuses anything outside the list. The
provider still re-checks its own value — the admin form is not the only way in.

Both endpoints must be fixed constants. The two token keys are added to
`SECRET_KEYS` automatically — a provider author never lists them, and deriving
them is what stops an access token coming back in cleartext.

For a source provider, add `"source"` to `capabilities` and a `source` block.
The registry test asserts the two agree in both directions: a block without the
capability is invisible to the catalog, and the capability without the block is a
sync that throws on its first run.

```ts
capabilities: ["source"],
source: {
  settingFields: [{ key: "baseId", label: "Base ID" }],
  async pull(ctx) {
    const url = new URL(`https://api.acme.test/v1/${encodeURIComponent(ctx.setting("baseId")!)}/rows`);
    if (ctx.cursor) url.searchParams.set("offset", ctx.cursor);   // query param, never a path segment
    const res = await ctx.fetch(url.toString(), {
      headers: { Authorization: `Bearer ${ctx.str(OAUTH_ACCESS_TOKEN_KEY)}` },
    });
    if (!res.ok) throw new Error(`Acme responded ${res.status}`);  // throwing is how a run fails
    const body = await res.json();
    return { records: body.rows.map((r) => ({ externalId: r.id, data: r })), cursor: body.next ?? null };
  },
},
```

Treat both the settings and the cursor as untrusted: the first came from an admin
form, the second from the provider's own previous answer. Unlike `deliver`, a
`pull` that throws is **not** swallowed — a failed delivery loses one
notification, but a failed pull that reported success would advance the cursor
past rows nobody read.

Returning `null` from `deliver` marks the integration misconfigured; any throw
is caught. A broken provider can never break the write path that fired the
event.
