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

Thirty-four providers ship in the registry, grouped by category:

| Category | Providers |
|---|---|
| chat | Slack, Discord, Microsoft Teams, Telegram, Google Chat |
| observability | Datadog, Sentry, PagerDuty, Opsgenie |
| analytics | PostHog, Segment, Mixpanel, Amplitude |
| issue tracking | GitHub, Linear, Jira |
| search | Algolia, Meilisearch, Typesense, Elasticsearch / OpenSearch |
| productivity | Notion, Google Sheets, Google Drive, Google Calendar *(OAuth)*, Airtable *(OAuth)*, Contentful — all sources |
| accounting | QuickBooks Online, Xero — both *(OAuth)*, both sources **and destinations** |
| warehouse | ClickHouse, Google BigQuery — both *destinations* |
| crm | HubSpot — *receives record contents*, see below |
| marketing | Mailchimp, Klaviyo — both sources **and destinations** |
| marketplace | Trendyol — a source, a destination **and** tasks |

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

### Records that have lines

Every source above pulls a **flat** record: a spreadsheet row, an Airtable
record, a calendar event. An order is not that shape — it is a header plus its
lines, and those belong in two collections.

`childMappings` says where the lines go, keyed by the group name the provider
hands them back under:

```bash
backlex integrations sync-create --integration <id> --collection orders \
  --set … --map orderNumber=number --map grandTotal=total \
  --children '{"items":{"collection":"order_items","parentField":"order",
                        "mapping":{"sku":"sku","quantity":"qty"}}}' \
  --every 15
```

- The **group name** is the provider's. A source that returns children declares
  the groups it can hand back, so the admin's sync dialog offers them by name
  and a group the provider never returns is refused when the sync is saved —
  without that, a mistyped group is not an error at all: it matches nothing, and
  the sync imports orders without their lines while reporting a clean run.
- `collection` must be **managed**, same as the parent's.
- `parentField` is the relation column on the *child* collection pointing back
  at the header. The engine fills it from the parent's own namespaced id —
  never from provider data, so a line cannot be pointed at a row in another
  workspace.
- `mapping` is `external → child field`, exactly like the parent's.
- A group the sync has no mapping for is **ignored**. A provider may return more
  groups than you kept, and refusing those would make adding a group to a
  provider a breaking change for every existing sync.

A child's primary key is qualified by its parent's:
`<provider>_<sync-prefix>_<order-id>:<line-id>`. That is what lets a provider
number an order's lines from 1 without every order's first line colliding on one
key.

**Children are upserted, never reconciled.** A line removed at the provider
stays in the collection, exactly as [a delete does everywhere else](#what-a-push-cannot-do)
— a page walk only ever sees what still exists. Marketplace orders cancel rather
than lose lines, so this is stated rather than paid for with a delete-then-insert
that would churn ids on every pull.

Pull only. A push walks one collection's watermark and has no notion of a child.

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

Both can also travel the other way — see [Invoices out to the
ledger](#invoices-out-to-the-ledger).

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

### Destinations that are not warehouses

A warehouse takes a batch of arbitrary columns in one request. Google Calendar
does not, and the two differences it forced are declared on the provider rather
than special-cased in the engine:

| Declaration | Why |
|---|---|
| `destination.columns` | A calendar event has a `summary` and a `start`, not arbitrary columns. With the set declared, an unknown mapping target is refused **at the form**; without it the provider would drop the field and the run would report a clean success having written nothing. The connect dialog renders a dropdown from the same list. |
| `destination.batchSize` | There is no bulk endpoint — one or two HTTP calls **per row**. The engine's 200-row default would be 400 subrequests, past what a Worker invocation is allowed. Clamped down only; a provider cannot ask for a bigger page. |
| `destination.requiredScope` | The OAuth grant a *write* needs that merely connecting did not imply. Checked when the sync is **saved**, against what the token exchange recorded. A list means every one of them — Xero grants write per record type. |

A column may carry `when`, naming the settings it applies under: QuickBooks
writes a customer **or** an invoice, and those share no columns at all. The
catalog ships the full list with each column's condition, so the connect dialog
narrows the picker as the operator chooses the record type — and the server
narrows the same list when the mapping is saved, changed, *or* when the record
type changes underneath a mapping that was already valid.

A warehouse declares none of it, and nothing about it changes.

## Bookings out to a calendar

Google Calendar is a source **and** a destination: it mirrors a calendar in, and
it turns rows into events.

```bash
backlex integrations sync-create --integration <id> --collection appointments \
  --direction push --set calendarId=primary --set timeZone=Europe/Istanbul \
  --map service=summary --map starts_at=start --map ends_at=end \
  --map address=location --map customer_email=attendees --every 15
```

Mappable columns: `summary`, `description`, `location`, `start`, `end`,
`attendees`.

**The event id is derived, and that is the whole design.** A destination's
contract is that a re-sent batch must not duplicate, and a calendar has no
natural key to upsert on. Google is unusual in letting the caller **choose** an
event id, so backlex derives it from `SHA-256(sync, row id)`: the same row always
addresses the same event, so an edited booking moves the entry the guest already
accepted instead of booking a second one. The **sync** is in the hash because two
collections can hold the same primary key, and without it two syncs pointed at
one calendar would overwrite each other's events.

The write is `insert`, then `update` on the `409` that a duplicate id returns.

Other behaviour worth knowing:

- **Dates.** A `YYYY-MM-DD` value is an **all-day** event; anything else is an
  instant. An all-day `DTEND` is *exclusive*, so a one-day event ends on the
  following date. A start with no end gets an hour (or a day).
- **Guests** come from a text column (comma- or semicolon-separated) or a JSON
  array of strings or `{email}` objects. Non-addresses and duplicates are
  dropped and the list is capped at 50 — every surviving entry is somebody
  Google may email.
- **Nobody is notified** unless the sync's *Notify attendees* setting says so.
- **A row with no start is skipped**, not failed: one empty date column should
  not stop the rest of the batch.
- **Deletes are invisible**, exactly as for a warehouse — a watermark walk only
  ever sees rows that still exist.
- **A `403` means two different things.** Google returns it both for "this token
  cannot write" and for "you are going too fast", and the two want opposite
  responses, so they are reported as different messages.

**Existing connections need re-authorizing.** Write needs the
`calendar.events` scope, which a connection authorized when Calendar was
source-only never granted. Pulls keep working, and creating a push sync on such
a connection is **refused when you save it** — checked against the scope list
the token exchange recorded, not against what was asked for. A provider that
records no scope list is allowed through; the far end's 403 is the backstop.
Reconnect the integration and the sync saves.

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

## Invoices out to the ledger

QuickBooks and Xero are sources **and** destinations: they mirror your books in,
and they turn rows into customers, contacts and invoices. This is the case
invoicing, ecommerce and SaaS collections keep re-keying by hand.

```bash
# Customers out to QuickBooks
backlex integrations sync-create --integration <id> --collection customers \
  --direction push --set entity=Customer --set environment=production \
  --map company=displayName --map billing_email=email --map phone=phone --every 60

# Invoices out to Xero, left as drafts
backlex integrations sync-create --integration <id> --collection invoices \
  --direction push --set endpoint=Invoices --set invoiceStatus=DRAFT \
  --set accountCode=200 \
  --map number=invoiceNumber --map customer_name=contactName \
  --map total=amount --map issued_on=date --map due_on=dueDate --every 60
```

| Provider | Record types | Mappable columns |
|---|---|---|
| QuickBooks | `Customer` | `displayName`, `companyName`, `email`, `phone`, `notes` |
| QuickBooks | `Invoice` | `docNumber`, `customerName`, `amount`, `description`, `txnDate`, `dueDate`, `currency` |
| Xero | `Contacts` | `contactNumber`, `name`, `firstName`, `lastName`, `email`, `phone`, `taxNumber` |
| Xero | `Invoices` | `invoiceNumber`, `contactName`, `amount`, `description`, `date`, `dueDate`, `currency`, `reference` |

### Neither one has an upsert

That is the fact everything else follows from. Google Calendar lets the caller
choose an event id; an accounting API does not, so a push **finds** the record
first and only then decides create-or-update. The key it searches on is:

- **an invoice number** — the mapped column when the collection carries one,
  otherwise `BX-` plus twelve hex characters derived from `SHA-256(sync, row
  id)`. Same row, same invoice, forever; and the **sync** is in the hash because
  two collections can hold the same primary key.
- **a contact code** for Xero contacts, derived the same way, mappable the same
  way. Map your own customer code to reconcile with contacts Xero already holds.
- **the display name** for QuickBooks customers, because QuickBooks has nowhere
  else to put a reference and requires the name unique. That is the one place
  row data reaches a provider query, and it is escaped before it does — an
  apostrophe is an ordinary thing for a customer to have in their name.

Lookups are **per batch**, not per row: one `in (…)` query for QuickBooks, one
`where` expression for Xero.

### What each provider does differently

| | QuickBooks | Xero |
|---|---|---|
| Writing a batch | one call **per row** (batch of 20) | **one** call for the batch (batch of 25) |
| Updating | sparse — fields you did not map are left alone | the fields you send; **line items replace** |
| An invoice's customer | must exist; created for you unless the sync says *skip* | named on the invoice, Xero creates it |
| Existing connections | can already push — Intuit's accounting scope is read **and** write | must be **reconnected**; Xero grants write per record type |

### Things that will otherwise surprise you

- **A paid or voided Xero invoice is skipped.** Xero refuses to modify one, and
  a permanent `400` on a row that is simply finished would be retried until the
  breaker paused the sync.
- **Xero invoices are `DRAFT`** unless the sync says otherwise. An automation
  that posts to the ledger on its first run is not something to opt out of.
- **A structurally incomplete row is skipped, not failed** — an invoice with no
  customer or no amount, a contact with no name. One empty column must not
  strand the rest of the batch.
- **Amounts are parsed, not assumed.** A `decimal` column arrives as a string,
  and `1.234,56` and `$1,234.56` both mean the same thing. Anything that is not
  a number skips the row rather than posting a zero.
- **Dates become calendar days.** An accounting date is a day, and both APIs
  reject a timestamp.
- **QuickBooks line items** point at a product/service when the sync names one
  (by name — you know what yours are called, not what Intuit numbered them). A
  name that matches nothing fails the batch: filing every invoice against the
  wrong account is worse than stopping.
- **Xero line items** need an `accountCode` for the revenue to post where you
  expect. Xero's default applies without one.
- **Deletes are invisible**, exactly as for a warehouse.

## Contacts out to a marketing list

Mailchimp and Klaviyo are sources **and** destinations, and unlike every other
pair here both directions are needed rather than merely available: **consent
travels the other way.** Someone unsubscribes from an email, and unless the pull
brings that back, the collection goes on calling them a subscriber and every
later push argues with the provider about it.

```bash
# Subscribers out to a Mailchimp audience
backlex integrations sync-create --integration <id> --collection subscribers \
  --direction push --set audienceId=abc123 --set status=pending \
  --map email=email --map first_name=firstName --map last_name=lastName \
  --map is_subscribed=status --every 60

# …and Mailchimp's answer back, so unsubscribes reach the collection
backlex integrations sync-create --integration <id> --collection subscribers \
  --direction pull --set audienceId=abc123 --set status=any \
  --map email_address=email --map status=mc_status \
  --map unsubscribe_reason=mc_unsubscribe_reason --every 60

# Profiles out to a Klaviyo list
backlex integrations sync-create --integration <id> --collection customers \
  --direction push --set listId=LIST1 \
  --map email=email --map full_name=firstName --map company=organization --every 60
```

| Provider | Mappable columns (push) | Notable pull fields |
|---|---|---|
| Mailchimp | `email`, `firstName`, `lastName`, `phone`, `birthday`, `status` | `email_address`, `status`, `unsubscribe_reason`, `tags`, plus every merge tag (`FNAME`, `LNAME`, …) at the top level |
| Klaviyo | `email`, `phone`, `externalId`, `firstName`, `lastName`, `organization`, `title` | `email`, `email_marketing_consent`, `sms_marketing_consent`, `properties`, `location` |

### Consent is never guessed

The two providers model consent differently, and this is the one place where
that difference is visible rather than smoothed over.

- **Mailchimp gives every contact a status**, so the push setting is required
  and has **no default**. Picking one on your behalf would be backlex deciding
  that the people in a database agreed to be marketed to. `pending` is double
  opt-in — Mailchimp emails them to confirm; `subscribed` is only correct if you
  already hold consent; `transactional` is receipts and notices, no marketing.
- **A mapped `status` column wins over that setting** — the mapping is how a
  collection declares it owns consent, and it is how an unsubscribe held in
  backlex reaches Mailchimp. A `boolean` column reads as subscribed /
  unsubscribed. A value that means nothing to Mailchimp **skips the row** rather
  than falling back to the setting: a guess is worse than a contact that does
  not travel.
- **Klaviyo keeps membership and consent as separate facts**, and this provider
  only ever does membership. There is no setting to grant consent, on purpose —
  backlex holds no record that anyone agreed, so asserting it would be inventing
  the one fact that matters. Grant it in Klaviyo's own signup flows; the pull
  brings the answer back as `email_marketing_consent`.

### Things that will otherwise surprise you

- **A contact the provider refuses is skipped, not failed.** Someone who
  unsubscribed cannot be re-added by an API call, by design. Failing the batch
  would hold the [watermark](#the-watermark) on that row forever and the
  contacts behind it would never be reached again — one opted-out address would
  wedge the sync. The trade is stated rather than hidden: that contact does not
  travel, and is retried the next time its row is edited.
- **A batch where *every* contact was refused does fail.** One refusal is data;
  all of them is a wrong audience or a mis-mapped email column, and a clean run
  there would step over rows nothing received.
- **The Mailchimp host is in the API key.** The key ends `-us14`, and that suffix
  *is* the data centre. Nothing asks you for it, and a key without a valid one is
  refused before any request is made.
- **Tags are never written.** Mailchimp's batch endpoint replaces a contact's
  tags with the request's, and a sync that has nothing to say about tags would
  wipe segmentation built by hand. They come back on the pull; they do not go out.
- **Only Mailchimp's default merge tags are mappable** — `FNAME`, `LNAME`,
  `PHONE`, `BIRTHDAY`. Custom merge tags are a gap: the endpoint drops an unknown
  tag without complaint, so accepting one would report a clean run while losing a
  column.
- **`BIRTHDAY` is `MM/DD`.** A year makes Mailchimp reject it, so a date column is
  converted; an unparseable one is dropped and the contact's other fields still go.
- **A Klaviyo phone that is not E.164 is dropped**, not sent. Klaviyo `400`s the
  whole profile on a bad number, which would cost the contact its name, its
  company and its list membership too.
- **A Klaviyo row with no email, phone or external id is skipped.** There is
  nothing to upsert *on*, and the call would mint a fresh anonymous profile on
  every run.
- **Klaviyo's API revision is pinned** in the provider. An unpinned revision
  changes response shapes underneath a running sync.
- **Deletes are invisible**, exactly as everywhere else. Removing a row does not
  remove the contact — unsubscribe them through a mapped `status` column instead.

## Doing one thing to one row

A **task** is the fourth shape, and the one the first three cannot express. A
sink is told a row changed. A source reads rows in on a schedule. A destination
mirrors a collection out on a watermark. None of them can do *take this row, act
on it at the provider, and write what came back onto it* — which is exactly what
booking a shipment is: one row in, a tracking number and a label out, both
belonging on the row that asked.

```bash
backlex integrations task-run <integration-id> create_shipment \
  --collection fulfillments --item ful_123 \
  --set service=standard \
  --out trackingNumber=tracking_number --out labelKey=label_key
```

`--out` maps the task's **declared** outputs onto your columns. Read what a task
declares from the catalog; an output the provider never declared, or a target
that is not a writable field, is refused when you invoke it rather than dropped
on the floor.

### It runs once

This is the part that makes a task different from everything else in this
engine. A lost sink delivery is a duplicate notification. A re-read page is
free. A re-sent batch is collapsed on merge. **A second shipment costs money and
confuses a courier.**

So a task runs at most once per row, and the guard is a database row under a
unique index rather than a check the code performs:

| | |
|---|---|
| A second call | returns the **first run's outputs**, and reports `reused` — an operator who clicked twice wants the label, not an error |
| Two concurrent calls | race to insert; exactly one reaches the provider |
| A **failed** run | is retried, because the alternative is a shipment nobody can ever record |
| `--force` | is the only way past it, for a consignment genuinely cancelled at the carrier and rebooked |

The engine also hands the provider an idempotency key, stable across every retry
of the same row. Carriers that honour it refuse the duplicate at their end too,
which is strictly better than us noticing afterwards.

### What a task produced

`backlex integrations task-runs --collection fulfillments --item ful_123` is the
operational answer to *which orders have a label and which are still waiting*.

A task that produces a **file** — a carrier's label PDF — has it stored before
anything references it, and the declared artifact output receives its **storage
key**, not a URL. A signed URL expires, and a column full of dead links is worse
than one the reader signs on demand. The key is derived from the run and scoped
under the workspace; a filename a third party supplied is never used to build a
path.

## Orders in from a marketplace

**Trendyol** is the first provider that uses three capabilities at once, and it
is what the child mappings and the task shape were built for: orders come **in**
as a header plus its lines, stock and price go **out**, and the two status
notifications a seller owes the marketplace go back as tasks.

Connect it with the seller id and the API key pair from **Account → Integration
Details** in the seller panel. There is no OAuth — Trendyol issues a key per
supplier, and it is the master user who can see it.

```bash
backlex integrations connect --kind trendyol \
  --set sellerId=123456 --set apiKey=… --set apiSecret=… \
  --set storeFrontCode=TR --set environment=production
```

`storeFrontCode` is the market this connection addresses (`TR`, `DE`, `RO`, `AE`
…) and is sent on every request. `environment` picks production or Trendyol's
stage gateway — the stage one needs a separate test seller and an IP
authorisation from Trendyol, so it is not a sandbox you can simply switch on.

### Orders and their lines

```bash
backlex integrations sync-create --integration <id> --collection orders \
  --set lookbackDays=14 \
  --map shipmentPackageId=channel_package_id --map orderNumber=number \
  --map orderDate=placed_at --map totalPrice=total --map currencyCode=currency \
  --map shipmentCity=ship_city --map shipmentDistrict=ship_district \
  --children '{"lines":{"collection":"order_items","parentField":"order",
                        "mapping":{"stockCode":"sku","productName":"title",
                                   "quantity":"qty","unitPrice":"unit_price"}}}' \
  --every 15
```

Three things about this sync are worth knowing before you run it:

**It reads by last-modified date, not by order date.** A package pulled as
`Created` and shipped an hour later is picked up again, which is what keeps the
collection agreeing with Trendyol rather than freezing every order at the status
it had when it first arrived. There is deliberately **no status filter** on the
sync for the same reason — narrow it in a view over the collection, where
changing your mind costs nothing.

**A run reads at most a fortnight**, because that is the widest window the API
accepts. A seller with a long history therefore backfills a window per run,
walking forward, and the sync's cursor is where the next one starts.

**Pages are five seconds apart.** Trendyol asks for that interval on the order
stream, and it is enforced here — a first page is immediate, a multi-page
backfill takes its time. Everything else this provider does runs at the API's
ordinary pace, so a status notification is never made to wait behind it.

The address is flattened into its parts on the way in — `shipmentCity`,
`shipmentDistrict`, `shipmentNeighbourhood`, `shipmentPostalCode`,
`shipmentCountryCode` — because a Turkish address is il / ilçe / mahalle and a
courier needs all three. Map them onto columns now and the carrier integration
never has to go back for the order.

:::note
Map `shipmentPackageId` onto a column of your own. It is what the two tasks
below act on, and it is not the same thing as the order number — a single order
can be split into several packages, and each of them ships separately.
:::

### Stock and price out

The push mirrors a variant collection onto Trendyol's listings, matched by
barcode:

```bash
backlex integrations sync-create --integration <id> --collection product_variants \
  --direction push --set updates=stock \
  --map barcode=barcode --map inventory_quantity=quantity --every 30
```

`updates` decides what leaves your instance — `stock`, `price`, or `both` — and
the column picker narrows with it. That is not decoration: Trendyol reads an
omitted field as *leave it alone*, so a stock sync that also sent a price would
quietly overwrite whatever the seller set in their panel. A price sync with no
list price mapped sends the sale price as both, which is the reading that means
"no crossed-out price" rather than a batch refused for a column nobody filled in.

Prices and stock land in a queue at Trendyol, so the response is a batch id
rather than an answer. The push asks what became of it once. A batch where
**every** item was refused fails the run — that is a barcode mapping pointed at
the wrong column, and the rows should be re-sent once it is fixed. One bad item
among two hundred does not, because holding the watermark on an archived listing
would stop the sync ever reaching the rows behind it.

### Telling Trendyol what you did

Two tasks, one per notification a seller owes:

```bash
backlex integrations task-run <integration-id> mark_picking \
  --collection orders --item <row-id> \
  --set packageIdField=channel_package_id --out status=channel_status

backlex integrations task-run <integration-id> mark_invoiced \
  --collection orders --item <row-id> \
  --set packageIdField=channel_package_id --set invoiceNumberField=invoice_number \
  --out status=channel_status
```

They are two tasks rather than one with a status setting, and that is forced by
the [once-only guard](#it-runs-once): it is keyed by *(integration, task, row)*,
so a single set-status task would mark a package `Picking` and then refuse to
mark it `Invoiced`, handing back the first run's answer instead of notifying
anybody. Two tasks means each notification happens exactly once — which is what
"exactly once" has to mean for a package that legitimately moves twice.

`packageIdField` names the column holding the Trendyol package id, which is why
the sync above maps it. Neither task sends line numbers: omitting them notifies
the whole package, which is what shipping it in one piece means. Trendyol
expects `Picking` before `Invoiced` and says so itself if you get it the wrong
way round — that order is not second-guessed here, because a package already
picked from the seller panel would otherwise be un-invoiceable through the API.

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

### Being rate limited is not being broken

A provider with a published quota answers a page walk with `429`, and that is
deliberately **not** a breaker failure:

| | |
|---|---|
| The counter | does not advance — five throttled runs never pause a sync |
| The cursor | is held, exactly as for any other failure, so rows are re-read rather than skipped |
| The row | still records the reason, so a run that landed nothing is never silently clean |
| The retry | is the queue's own backoff, spaced by the provider's `Retry-After` when it sent one |

Providers that publish a quota also declare it, and the engine spaces requests
out ahead of time so the common case never earns a 429 at all. That pacing is
**per-isolate and best-effort**: it keeps one run's twenty pages polite, and two
isolates running two syncs cannot see each other. The 429 handling above is what
makes the system correct; the pacing only makes it quiet.

Buckets are keyed per **connected account**, not per provider — two workspaces
holding two sellers' credentials have independent quotas at the far end, and
pacing them against each other would halve what each of them is entitled to.

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

### Asking a provider to act on a row

`integration.task` is the other half: it does not tell a provider that something
happened, it asks one to *do* something and waits for the answer.

```json
{
  "type": "integration.task",
  "kind": "trendyol",
  "task": "mark_invoiced",
  "collection": "orders",
  "itemId": "{{ data.id }}",
  "settings": { "service": "standard" },
  "outputMapping": { "trackingNumber": "tracking_number" }
}
```

`outputMapping` lives on the step rather than in stored config because the same
task serves collections that name their columns differently — you say once, in
the step, where a tracking number lands. An output you map nowhere is still
returned to the flow; it is simply not written onto the row.

Three things differ from the message step, and each follows from a task having a
real-world effect:

- **A missing connection fails the run.** A chat notification nobody received is
  a notification. A shipment nobody booked is an order the next step marks as
  shipped, so a provider that is not connected — or is paused — is an error here
  rather than a skip.
- **It runs [once per row](#it-runs-once).** A flow that re-fires reads the first
  run's answer back instead of booking a second shipment, and the step reports
  `reused: true` so a following `condition` can tell the two apart. `force: true`
  is the escape hatch for a consignment genuinely cancelled at the carrier.
- **The step is checked when the flow is saved.** A task the provider does not
  declare, a setting outside its option set, or an output key it never returns
  is refused at save time. At run time all three present the same way: a step
  that failed on a real order, with nothing in the flow that looks wrong.

In the flow builder this is the **Integration task** action. Every picker in it
is built from the provider's own declaration — only providers that *have* tasks
are offered, the settings are the ones that task declares, and an output can
only be pointed at a writable field of the chosen collection.

## Surfaces

| Surface | Entry point |
|---|---|
| REST | `/api/admin/integrations` (+ `/catalog`, `/syncs`, `/task-runs`, `/{id}/deliveries`, `/{id}/resume`, `/{id}/tasks/{task}`, `/{id}/oauth/authorize`) |
| SDK | `client.integrations.*` |
| GraphQL | `integrationCatalog`, `integrations`, `integrationSyncs`, `integrationDeliveries`, `connectIntegration`, `resumeIntegration`, `disconnectIntegration`, `startIntegrationOAuth`, `createIntegrationSync`, `updateIntegrationSync`, `deleteIntegrationSync`, `runIntegrationSync`, `integrationTaskRuns`, `runIntegrationTask` |
| MCP | `integrations.catalog` / `.list` / `.connect` / `.deliveries` / `.resume` / `.disconnect` / `.oauth_authorize` / `.syncs` / `.create_sync` / `.update_sync` / `.delete_sync` / `.run_sync` / `.run_task` / `.task_runs` |
| CLI | `backlex integrations …` |

`/api/admin/integrations/oauth/callback` is the provider's redirect target. It
is not part of the API you call: it always answers with a redirect into the
admin UI, because the caller is a browser mid-navigation.

All five funnel through one service, so the tenant guards, the encryption at
rest and the breaker are shared rather than restated per surface — including
`direction`, so a mirror-out can be scheduled from any of them and not only
from the admin UI.

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

A source whose records have rows beneath them declares the groups it returns, so
that a picker has something to offer and a mistyped group is refused at save
time rather than matching nothing at run time:

```ts
source: {
  childGroups: [{ key: "lines", label: "Order lines" }],
  // …and `pull` returns `children: { lines: [{ externalId, data }] }`
},
```

Leave it off for a flat source. "Declares none" and "declares nothing" are the
same thing to every consumer, and an empty list only invites a picker with
nothing in it.

Treat both the settings and the cursor as untrusted: the first came from an admin
form, the second from the provider's own previous answer. Unlike `deliver`, a
`pull` that throws is **not** swallowed — a failed delivery loses one
notification, but a failed pull that reported success would advance the cursor
past rows nobody read.

Returning `null` from `deliver` marks the integration misconfigured; any throw
is caught. A broken provider can never break the write path that fired the
event.
