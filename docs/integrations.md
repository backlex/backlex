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
Integrations are *credentialed*: you paste a provider credential, backlex
encrypts it at rest, and it is never readable again. Traffic goes both ways —
events fan out, rows are pulled in, and a provider that declares a
[webhook](#when-the-provider-calls-you) calls us. That is the difference from
[outbound webhooks](/docs/webhooks/), where you own the receiving endpoint and
backlex signs what it sends.
:::

## Providers

Forty-nine providers ship in the registry, grouped by category:

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
| marketplace | Trendyol — a source, a destination, tasks **and** an inbound webhook; Hepsiburada, n11, Çiçeksepeti — each a source, a destination and tasks; Amazon — a source, a task and a listing; eBay — a source, a task and a listing, over OAuth; Otto — a source, a task and a listing; Allegro — a source, a task and a listing (browsed a level at a time); bol.com — a source, a DESTINATION and a task |
| carrier | EasyPost — tasks (book a shipment, read where it is, cancel it) **and** an inbound webhook; Yurtiçi Kargo — the same three tasks, over SOAP; Aras Kargo — book and cancel, over SOAP; DHL — tracking only, across every DHL division including DHL eCommerce Türkiye (ex-MNG Kargo); DHL Express — book with a label, and **no cancel, because DHL Express has none**; PTT Kargo — all four (book, label, track, cancel), over SOAP; UPS — book with a label, track, void |

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

### Except when asking again *is* the point

Some tasks change nothing at the provider. *Where is this parcel* is a read, and
its whole value is that the answer moves: `pre_transit` today, `delivered` on
Thursday. Run one of those under the guard above and the row keeps the least
useful answer it will ever have — the one from before the parcel left.

A provider marks such a task **repeatable**, and the table inverts:

| | |
|---|---|
| A second call | asks the provider again and keeps the **newer** answer |
| Two concurrent calls | both reach the provider — neither is doing anything the other needs protecting from |
| `--force` | has nothing to force, and is ignored rather than refused |

What does *not* change: the run is still recorded, so *what did the carrier last
say, and when* survives; there is still one run row per *(integration, task,
row)* rather than one per poll; and the outputs a task may write are still only
the ones it declared. Repeatable relaxes the guard, not the contract.

Poll one on a schedule with a cron flow over the open shipments — see
[flows](./flows.md). Only a provider can declare it: `repeatable` is a statement
about the provider's API having no side effect, which is not something a caller
is in a position to promise.

### It writes back a patch, not a row

A task hands back the two or three fields it learned. The engine writes **only
those columns** and leaves the rest of the row exactly as it was — so booking a
shipment onto a fulfillment sets the tracking number and the label key without
touching which order it belongs to, which location it ships from, or the status
somebody set by hand five minutes ago.

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

### A second marketplace: Hepsiburada

**Hepsiburada** is the answer to the question Trendyol left open — is a
marketplace one file now? Almost. Its source, destination and tasks are built
entirely out of shapes the engine already had, and no engine change was needed
for any of them. What is different is worth knowing before you wire one up.

Connect it with the merchant GUID and the API user Hepsiburada issued, and pick
the environment — it is a pair of hostnames (`-sit` for test), not a flag:

```bash
backlex integrations connect --kind hepsiburada \
  --config merchantId=<guid> --config username=<user> \
  --config password=<pass> --config environment=production
```

**A sync mirrors one feed, and you choose which.** Hepsiburada has no single
"everything that changed" endpoint: the lifecycle is split across endpoints that
each return a different entity. So the `feed` setting picks one —

| feed | what a record is | keyed by |
|---|---|---|
| `packages` (default) | a whole package, with address, status and lines | package number |
| `orders` | line items not yet packed, grouped into one record per order | order number |
| `cancelled` | cancelled line items, same grouping | order number |

Mirroring two of them into one collection is two syncs, and therefore two id
namespaces — which is what stops a package number and an order number, different
value spaces both, from ever colliding on a row.

**The window does not advance between runs**, and that is the one thing to
understand before tuning `lookbackDays`. Hepsiburada's `begindate` filters on
when a row was *created*, not last modified. A watermark that marched forward
would see each package exactly once — in whatever status it was created with —
and never learn that it shipped. So every run re-reads the same rolling window
from the top. Re-reading is free (rows are upserted); the window's width is the
trade between how far back a status change is still noticed and how much work a
run does.

The `orders` and `cancelled` feeds return a **flat list of line items**, which
the provider groups into one record per order number with the lines as children.
An order split across two pages is fine — children are upserted, so the second
page adds the lines the first did not carry.

Stock and price are two separate uploads on a second host, and both are async:
the upload answers with an id and whether the listings took it is a second call.
That call fails the run only when *every* item was refused, which is a mapping
error worth holding the watermark for — one archived listing among two hundred
is not, and would otherwise stall the sync for ever. Same asymmetry as
Trendyol's, for the same reason. A listing is addressed by the HBSKU, the
merchant's own SKU, or both; a row carrying neither is refused before anything
is sent.

Six tasks cover fulfilment — `mark_intransit`, `mark_delivered`,
`mark_undelivered`, `send_invoice_link`, `get_label` and `refresh_package`. They
are separate tasks for the same reason Trendyol's two are: the once-only guard
is keyed by *(integration, task, row)*, and a package legitimately moves several
times. `refresh_package` is the only [repeatable](#except-when-asking-again-is-the-point) one — it is a
read.

`get_label` hands the barcode payload back **verbatim** rather than storing it
as a file. Hepsiburada documents the response as `{ data: string[], format }`
and the *encoding* of those strings is not part of the contract, so calling it a
PDF and storing it as one would be a guess. Same rule as [EasyPost's label
host](#a-missing-label-never-undoes-a-booking).

**There is no webhook block, and that is a finding rather than an omission.**
Hepsiburada does have a push model, but it does not POST to one endpoint you
give it: it requires the seller to stand up a REST API under a base URL and
implement a route per event — `POST {base}/orders`, `PUT
{base}/packages/{no}/intransit`, and so on — secured with credentials shared out
of band, with no registration API and a manual test sign-off. Supporting that
means one subscription owning several routed paths and two methods, which is a
real extension to the webhook contract rather than a quirk a provider can
absorb. It is deliberately not built on the strength of one example. The poll
repairs itself in a way a missed delivery never does, and the published
allowance is a thousand requests a second, so the cost of waiting is low.

### n11 and Çiçeksepeti

Two more, and between them they answer the question phase 4 was asked to
settle: **a marketplace is one file.** Neither needed an engine change, and
neither invented a shape — an order is a header with lines, a status
notification is a task, a price push lands in a queue that gets asked about
afterwards.

What is worth knowing is where each one differs.

**n11** is Trendyol's shape almost line for line. Connect it with the app key
and secret from the seller panel — they go in headers (`appkey`, `appsecret`)
with no Authorization scheme at all:

```bash
backlex integrations connect --kind n11 --config appKey=… --config appSecret=…
```

Its one non-obvious decision is `orderByField=true`, which this provider sends
on every request and does not offer as a setting. By default n11's date window
bounds order *creation*; that flag re-points it at `lastModifiedDate`. A sync
that mirrors is the only thing the source is for, so the flag is not optional —
without it a package would be seen once, in the status it was born with.

Two smaller things it does deliberately: a package with **no package number**
(location-specific delivery — `KTN`, `EASYPOINT`, `PUP`) lands under its order
number with an `order-` prefix rather than being dropped, because package
numbers and order numbers are both long digit strings and sharing an id
namespace is how one row silently overwrites another. And there is **one** task,
`approve_package`, because n11 documents exactly one transition today; the rest
arrive as more tasks when they arrive. It finds its own line ids from the
package rather than asking you to keep a list of them in a column.

**Çiçeksepeti** is the one to read the pacing notes for. Its rate limits are
published per endpoint *and per request body*:

| endpoint | same body | different body |
|---|---|---|
| `Order/GetOrders` | 1 / minute | 1 / 5 seconds |
| `Order/statusupdate…` | — | 1 / 5 seconds |
| `Products/price-and-stock` | 1 / 30 minutes | 1 / second |

A page walk changes the body every page, so five seconds is what binds — paced
from the same bucket Trendyol's order stream uses, keyed per endpoint and per
seller so an operator clicking a button never queues behind a page walk. Budget
for it: a status task reads the order first (to find its sub-order ids) and that
read takes a token too.

Its window is **re-walked, not advanced** — Çiçeksepeti does not document
whether its date filter bounds the order date or the modification date, and
re-reading is the only choice correct under both readings.

A main order splits into **sub-orders**, and every operation — status, cargo
barcode, delivery — addresses a sub-order. They are grouped into one record per
order with the sub-orders as lines, and the five status tasks
(`mark_preparing`, `mark_ready_to_ship`, `mark_shipped`, `mark_in_vehicle`,
`mark_delivered`) find their own sub-order ids. `mark_in_vehicle` is not a
synonym for shipping: an order going out on Çiçeksepeti's own service vehicle is
*refused* the "handed to the carrier" status, so it gets its own word.

`mark_shipped` requires the courier and the tracking number, because
Çiçeksepeti emails and texts the customer from exactly those fields — the
courier is picked from a list of the ids it publishes, not typed.

### eBay, Otto and Allegro — Europe, and what the shape could and could not hold

eBay is the sixth marketplace and the first reached over **OAuth**: you paste an
App ID, a Cert ID and a **RuName** and then press Connect. The RuName is the part
worth knowing about — eBay's authorization flow does not take a callback URL at
all, it takes an opaque handle eBay minted for the application, and the real URL
is registered against that handle in eBay's own portal. The provider says which
config key holds it and the engine sends that.

eBay also answers a publish with the verdict rather than a ticket, which is why
`ListingBatch` no longer calls its final-answers field `rejected` — the field
carries accepted units too, and is now `settled`. A run against eBay therefore
finishes with nothing pending and no batch to watch.

**Otto is the counter-example, and it is the one that names the rule.** Its
contract is public too, and it *does* list — because its taxonomy is
enumerable. One paged walk of `GET /v5/products/categories` returns category
groups carrying their categories, their attributes AND their variation themes,
so a single call answers the whole mapping form. Otto also keeps its own brand
registry, so brand is a searchable lookup rather than a string, and it mints its
token from a partner username and password rather than a redirect — so there is
no Connect button, just credentials.

One thing Otto would not tell us: which attributes are mandatory. Its
`relevance` field is a free string whose only published example is `HIGH`, so
only the exact word `MANDATORY` marks an attribute required and anything else is
left optional. That is the safe direction — a wrongly-required field blocks a
form somebody could have submitted, while a wrongly-optional one is refused by
Otto with its own message naming the field.

**Allegro is why a listing provider can now be WALKED.** Its API is entirely
public — 1.5 MB of OpenAPI, no account needed — but it will not hand over its
taxonomy: `GET /sale/categories` returns the children of one node and there is
no whole-tree endpoint, so enumerating roughly twenty-three thousand categories
would take thousands of round trips.

Every marketplace before it could be asked for its whole tree, which is why the
category picker was one search box over every leaf. So the shape gained a second
way to be read: a provider declares **either** `categories` (the whole tree, for
the marketplaces that will give it) **or** `categoryChildren` (the children of
one node), never both and never neither — the registry test enforces that, and
the catalog reports which as `browse: "all" | "levels"` so the admin knows which
control to draw before making a request. A level-walked picker drills down and
keeps what it has seen, so its breadcrumb still names the path: everything above
the node on screen was fetched on the way down.

Allegro also needs a **vendor media type** on every request
(`application/vnd.allegro.public.v1+json`; a plain `application/json` is a 406),
and its seller-status write is optimistically concurrent — it presents the
`revision` the order was read at, which is why that value is pulled onto the
order row.

**bol.com is the one that is deliberately not a listing at all.** Creating an
offer there is `{ean, condition, pricing, stock, fulfilment}` — no category, no
attributes, no title, no images. You are not putting a product on sale; you are
adding an OFFER against a product already in bol's catalogue, which is
destination-shaped. So bol brings orders in, mirrors **price and stock** out,
and reports a shipment back, and a test pins the absence of `listing` so nobody
completes it by inventing a category picker bol has no endpoint for. Same call
Hepsiburada's `fastlisting` got.

Two bol details worth knowing before you wire it: its token mint needs an
explicit `Content-Length: 0` (without it bol's edge answers **411**, which reads
like an outage rather than a malformed request), and its order list carries no
address — the address is a second call per order, which is why its page size is
smaller than bol's own maximum.

One lesson from building Allegro, worth more than the provider: its
`GET /sale/categories/{id}/parameters` endpoint is invisible to a naive scan of
the published swagger, and a **live probe** settled whether it exists — the path
answers Allegro's own `401 unauthorized` where a path that does not exist
answers a differently shaped `404`. Probe before believing an absence.

### Amazon, and what it proved

The fifth marketplace and the first outside Türkiye — which is the point. Four
providers fitting one shape could have meant the shape was Turkish. Amazon fits
it too, so the shape is marketplace-sized: an order is a header with lines, a
confirmation is a task, and neither the engine nor the record model needed
anything new.

It is still the most demanding of the five to connect, because its credential
is three values and its data is gated twice:

```bash
backlex integrations connect --kind amazon \
  --config region=eu --config marketplaceId=A33AVAJ2PDY3EV \
  --config sellerId=<merchant-token> \
  --config clientId=… --config clientSecret=… --config refreshToken=…
```

**Two tokens, not one.** Every request carries an access token minted from the
long-lived LWA refresh token, and the buyer's name and shipping address need a
*second*, restricted token minted for that exact path. Both are minted per
invocation and reused inside it — there is deliberately no cross-invocation
cache, because it would have to be a module-level map keyed by somebody's
refresh token.

If your application has not been approved for the PII role, the restricted
token is refused and the sync **degrades rather than fails**: it runs, and the
address columns stay empty — exactly what setting *Leave it redacted* would have
given you. Set that explicitly if you know you have no PII role, and save the
failing call every run.

**Lines are a second request, per order.** Amazon does not return an order's
items with the order. That is an N+1, and it is why the page is capped at 25
rather than the 100 the API allows — a page of 100 is 101 requests against an
endpoint limited to two a second.

**The rate limits are per operation and span two orders of magnitude:**
`getOrders` is 0.0167/s (one a minute, burst 20), `getOrderItems` 0.5/s,
`confirmShipment` 2/s. Each takes its own token, so confirming a shipment never
queues behind an order walk. Plan a first sync accordingly: a backfill advances
one 30-day window per run.

`confirm_shipment` needs an id and a quantity per line, so it reads the order's
items itself. Its `packageReferenceId` is derived from the engine's idempotency
key, which is stable across retries — so a retried run declares the *same*
package rather than a second one.

**There is no destination.** Price and quantity go through the Listings Items
API as JSON-patch operations against attributes whose exact value shapes are
defined per product type by the Product Type Definitions API, and are not stated
in the operation's own reference. Writing a seller's prices from a guessed
payload is the one failure worse than not shipping the feature — it reports a
clean run and changes nothing, or changes the wrong thing. It belongs in a
follow-up that reads the product type definition first.

## Parcels out to a carrier

A **carrier** provider is three tasks and nothing else, and those three are the
whole contract: *book this consignment*, *where is it*, *cancel it*. The
category is that contract rather than a company — a national courier and an
aggregator fronting thirty of them are the same shape from here, which is what
lets the next one arrive as one more file.

**EasyPost** is the first, and deliberately an aggregator: public docs, a
self-serve test key, and a real PDF at the end of it. A test key (`EZTK…`)
transacts against test carriers and costs nothing; a production key (`EZAK…`)
buys postage. There is no environment dropdown, because there is nothing for it
to switch — the key *is* the mode, and offering a picker would imply a
production key could be made safe by choosing "test".

The **ship-from address lives on the connection**. It is the workspace's own and
is the same on every consignment, so putting it on the task would mean re-typing
a warehouse address onto every flow step that books anything. Everything about
the *destination* is per-row, and named the way [Trendyol's tasks name
theirs](#telling-trendyol-what-you-did) — a setting per column:

```bash
backlex integrations task-run <integration-id> book_shipment \
  --collection fulfillments --item ful_123 \
  --set carrierAccount=ca_… --set service=Priority \
  --set toNameField=ship_to_name --set toStreet1Field=ship_to_street \
  --set toCityField=ship_to_city --set toZipField=ship_to_zip \
  --set toCountryField=ship_to_country --set weightField=weight_oz \
  --out shipmentId=carrier_shipment_id --out trackingCode=tracking_number \
  --out trackingUrl=tracking_url --out shipmentStatus=shipment_status \
  --out labelKey=label_key
```

That is a long list, and honestly so: booking a parcel needs a destination and a
weight, and there is no shorter truthful way to say which columns hold them. The
[e-commerce template](./templates.md) ships `fulfillments` with the columns
these outputs land in.

### It buys in one call

EasyPost's usual flow creates a shipment, reads its rates, then buys one.
Naming `service` and a carrier account on the create call makes it buy
immediately. A task is one row in and one answer out, and a three-request dance
with two places to die in the middle is not that.

A shipment that comes back **without a tracking number was not bought** — it
exists at EasyPost as a draft, which is what naming a service the carrier
account does not offer produces. That is an error here rather than a success
with an empty column, because the alternative is an order marked shipped
against a parcel no courier has heard of.

There is no idempotency header to send. The engine's
[once-only guard](#it-runs-once) is the *only* thing between a retry and a
second label, which is why `book_shipment` is not repeatable and `--force` on
it means what it says.

### A missing label never undoes a booking

The label comes back as a URL on a host EasyPost chose, and which host that is
has never been part of the documented contract. Fetching whatever a third party
puts in a JSON field is how a server ends up making requests somebody else
picked, so the host is checked against an allow-list before anything is fetched.

A label that fails that check — or 404s, or is too big — is **skipped, not
fatal**. By then postage is paid and a courier is expecting a parcel: failing
the run would have the queue retry it, and the retry books a second consignment.
A missing PDF is a nuisance; a second consignment is money and a confused
courier. The URL is still in the run's outputs either way.

### Where is it, asked on a schedule

`refresh_tracking` is [repeatable](#except-when-asking-again-is-the-point) — it
changes nothing at EasyPost and its whole value is that the answer moves. Put it
on a cron flow over the fulfillments that are not `delivered` yet.

It writes EasyPost's own status vocabulary (`pre_transit`, `in_transit`,
`out_for_delivery`, `delivered`, `available_for_pickup`, `return_to_sender`,
`failure`, `cancelled`) rather than a set invented here. Normalising thirty
couriers onto one list is an aggregator's whole job, and a second list would be
two things to keep in step. Anything outside it becomes `unknown` rather than a
value the column's picker never offered.

### Cancelling records what was asked, not what was granted

`cancel_shipment` refunds the label. Carriers take up to thirty days to answer,
so the status that comes back is `submitted` — and that is what lands on the
row. Writing `refunded` on the strength of having asked would not be true. The
one answer that is a refusal rather than a delay, `not_applicable`, is an error:
a row quietly reading it while an operator believes the consignment is cancelled
is worse than being told.

### A national courier, over SOAP

**Yurtiçi Kargo** is the second carrier and the first provider in this engine to
speak SOAP. It is the same three tasks — book, ask, cancel — because the
`carrier` category was defined as that contract rather than as a company,
which is what let a national courier arrive as one more file.

Its whole surface comes from the **published WSDL**, which is readable without
credentials. The credentials themselves still come from a branch application;
the contract does not.

```bash
backlex integrations connect --kind yurtici \
  --config wsUserName=… --config wsPassword=… --config language=TR
```

Four things differ from EasyPost and are worth knowing before you wire a flow:

**You choose the consignment key, and everything else addresses it.**
`book_shipment` derives `cargoKey` from the engine's idempotency key — stable
for this *(integration, task, row)* and identical across every retry — so a
retried booking re-books the *same* consignment instead of putting a second one
on a courier's manifest. There is no idempotency header here to fall back on,
which makes this the guard that matters. Map the output onto the column
`refresh_tracking` and `cancel_shipment` read.

**The credentials travel in the body**, not in a header: every operation's first
arguments are `wsUserName` and `wsPassword`. That is Yurtiçi's design.

**A refusal is a field inside a 200.** The service answers success at the HTTP
level and puts `errCode` in the payload, so a run that only checked the status
would report every refusal as a clean booking. Non-zero fails the run with the
courier's own `errMessage`.

**The address is il / ilçe by name** (`cityName`, `townName`) — which is exactly
what the marketplace sources in this engine already carry, so an order pulled
from Trendyol or Hepsiburada books without a lookup table in between.

`refresh_tracking` is [repeatable](#except-when-asking-again-is-the-point) and
writes Yurtiçi's own vocabulary rather than a remapped one — a second status
list would be a second thing to keep in step, and the operator's panel shows
these words. Its `keyType` is free text with a default of `0`, unusually for
this codebase: the WSDL types it as an integer and does not enumerate it, and a
picker built from a guess would be worse than a field you fill in from your own
contract documentation.

#### Aras Kargo, and a task that is missing on purpose

**Aras Kargo** is the second SOAP courier, and it is what the helper was written
for: the file is a translation, not a design. `book_shipment` and
`cancel_shipment` work the same way Yurtiçi's do, down to deriving the
consignment key (`IntegrationCode` here) from the engine's idempotency key so a
retry re-books the same consignment.

Two quirks are Aras's own. It wants the **credentials twice** — as arguments
*and* inside every order — and spells the username `userName` on the operations
this provider uses but `username` on its query operations; that is its WSDL, not
a transcription error. And the **cash-on-delivery flag and amount travel
together or not at all**: an amount with no flag is silently not collected,
which is the one failure here that costs the seller money.

**There is no tracking task**, deliberately. Aras's tracking operations
(`GetCargoTransaction`, `GetCargoInfo`, `GetSortedCargoInfo`) all return an
untyped .NET DataSet — the WSDL declares the response as `<s:any>` carrying a
diffgram, so the column names inside are not part of the published contract at
all. A task must declare the fields it writes back, and declaring names guessed
from somebody else's DataSet is how a row ends up permanently empty while the
run reports success. Those names *are* in the integration document Aras hands
over with the credentials; with that document in front of you the task is a
short addition, because the helper already reads an arbitrary tree by name.

#### UPS, and the shape that got lifted

**UPS** books a shipment with its label, reads where the parcel is, and voids
it. Two things about it are firsts for this engine.

**It is the first provider that mints its own token.** Every OAuth provider here
so far (Notion, Google, QuickBooks, Xero) uses the *authorization-code* grant,
which the engine drives: an admin is redirected, consents, and the engine stores
and refreshes the tokens. UPS uses *client-credentials* — no user to redirect,
no refresh token, just the credentials exchanged for a short-lived bearer at
`POST /security/v1/oauth/token`. That does not fit `IntegrationOAuth`, and
pretending it did would mean an authorize screen nobody can consent on. So the
exchange lives in the provider and the token is cached **keyed by the credential
pair**, not by client id alone: a rotated secret must not keep serving a token
minted from the old one. The cache is per-isolate and best-effort, like the
rate-limit buckets — a cold isolate mints a fresh token, which costs one request.

**It is the second user of the shared address shape, and the reason that shape
exists.** `@backlex/integrations/address` was lifted out of EasyPost when UPS
turned out to want the same fifteen settings under the same names — the rule
this repo already follows for `./soap`: two examples is when a shape stops being
one provider's business.

What is shared is the **international** postal shape (street, city,
state/province, postcode, ISO country) plus the parcel's weight and dimensions.
What is emphatically *not* shared is the Turkish couriers' shape — Yurtiçi, Aras
and PTT want il and ilçe **by name**, with no postcode and no country at all.
They are not a third example, and an abstraction that made a TR courier describe
Kadıköy as a "state/province" would be worse than the duplication it removed.

The keys in that module — `fromName`, `toNameField`, `weightField` and the rest
— are **frozen**. They are not names chosen there; they are names already stored
in live connections and flow steps, so renaming one would silently blank a
configured field on somebody's running flow. Each provider still owns its own
*translation*: UPS nests the street as an `AddressLine` array and spells the
postcode `PostalCode`, EasyPost calls the same two `street1` and `zip`. Keeping
that in the providers is what lets the shared module stay a description of a
postal address rather than a union of two carriers' wire formats.

What UPS adds on top of the shape is **units**: every weight and dimension
carries a `UnitOfMeasurement`, so the operator picks KGS/LBS and CM/IN on the
connection. EasyPost fixes ounces and inches instead, which is why the shared
placeholders take the unit as a parameter — a placeholder saying "ounces" over a
KGS connection is how a 5 kg parcel gets booked as 5 lb.

Three smaller things worth knowing:

- **`transId` and `transactionSrc` are required on every endpoint.** `transId`
  is a correlation id rather than an idempotency key (UPS publishes none), so it
  is derived from the engine's idempotency key — a support conversation about a
  retried booking then cites one reference instead of three. The engine's
  task-run row is the only guard against a retry buying a second label.
- **UPS answers with an object for one and an array for several**, throughout —
  `PackageResults`, `shipment`, `package`, `activity`, `deliveryDate`. A provider
  that indexed `[0]` on the object form would read `undefined` and report a
  successful booking with no tracking number.
- **The label arrives as base64 inside the response**, not as a URL to fetch —
  better than EasyPost's arrangement, where a separate host has to be
  allow-listed. It is stored under the extension of the format that was *asked
  for* rather than sniffed from the bytes: ZPL and EPL look like plain text, and
  a stored `.txt` a warehouse cannot send to its printer is a label nobody can
  use. A label that cannot be decoded is skipped rather than failing the run —
  by then the shipment is booked, and a retry would buy a second one.

Activities are documented most-recent-first, so unlike DHL the order is part of
the contract and the newest is simply the head.

#### PTT Kargo, the complete one

**PTT Kargo** is the third SOAP courier and the most complete carrier here: it
books, hands back a printable label, says where the parcel is, and cancels. It
is also the only national courier in this engine that produces a label at all.

It speaks through **two** services, and they differ in more than their address:

| | Acceptance | Tracking |
|---|---|---|
| Path | `/PttVeriYukleme/services/Sorgu` | `/GonderiTakip/services/Sorgu` |
| Namespace | `http://kabul.ptt.gov.tr` | `http://takip.ptt.gov.tr` |
| Stack | Axis2 | Axis 1.4 |
| SOAPAction | `urn:<operation>` | **empty** |
| Outcome field | `hataKodu` / `aciklama` | `sonucKodu` / `sonucAciklama` |

Both WSDLs are readable without any credential. The credentials come from a PTT
İl Müdürlüğü; the contracts do not — which is what unblocked this file, exactly
as it unblocked Yurtiçi and Aras.

Four things shape the provider, three of them verified against the live service:

- **A refusal is a field inside a 200.** Probed with deliberately wrong
  credentials, the acceptance service answers HTTP 200 carrying
  `<hataKodu>-1</hataKodu><aciklama>Kullanıcı Şifre Hatalı</aciklama>`. A booking
  says it a *second* time per parcel in `dongu.donguHataKodu`, so a batch can
  succeed with its only parcel rejected — reading just the outer code would write
  a barcode-less success onto the row.
- **The three credentials travel in three different combinations.** `kabulEkle2`
  wants username + password + customer id; `etiketGetir` and `barkodVeriSil` want
  customer id + password and **no username**; `gonderiSorgu` wants username +
  password and **no customer id**. That is the WSDL, not a transcription error.
- **We choose the reference, PTT chooses the barcode.** `musteriReferansNo` is
  derived from the engine's idempotency key so a retry re-books the same
  consignment. The barcode comes back in the answer and is what the label,
  tracking and cancel tasks all address, so one row field serves all three. PTT
  also publishes `referansVeriSil`, which cancels by our reference — the door to
  use if a booking's answer was lost before the barcode reached the row.
- **The label is EPL, and it is stored as such.** `etiketGetir` returns Eltron
  printer language, not a document — the bytes a thermal label printer consumes.
  It is stored through the engine's artifact mechanism as `text/plain` and the row
  is given its storage key. Converting it to a PDF would mean re-rendering
  somebody else's label layout.

**`fetch_label` is deliberately not repeatable**, which is the one judgement call
here. Asking PTT to render a label again has no effect on the parcel — but it
does write a fresh artifact into storage every run, and a repeatable task on a
cron would fill a bucket with copies of one label.

**Tracking ships even though it cannot be called yet.** `/GonderiTakip/` sits
behind a Layer 7 gateway that serves the WSDL to anybody and refuses every POST
with `Policy Falsified — Service Not Found`, whatever the body; the acceptance
service on the same host answers normally. That is a routing policy opened per
customer, not a fault in the request.

This is the *opposite* of Aras's missing tracking task, and the reason the two
decisions differ is worth keeping straight. Aras's tracking operations return an
untyped DataSet, so the field names cannot be known and the task cannot be
**written**. PTT's are fully typed in a published WSDL, so the task is written
correctly and the only open question is whether a given customer's account is
routed — one provisioning step, not a guess. The provider translates the
gateway's words into that: *ask your PTT İl Müdürlüğü to enable it for this
account*.

One last detail worth knowing: PTT's event history carries its own `siraNo`
sequence number, so **ordering is contract here rather than luck** — the provider
takes the highest one and does not care what order the transport delivered them
in. Compare DHL below, where no order is promised at all.

#### DHL, and half a carrier on purpose

**DHL** ships one task — `refresh_tracking` — and no booking. That is not an
oversight, and the shape is worth understanding because it will recur.

A carrier's three tasks are independent contracts, and DHL publishes them at
very different heights. **Tracking is public and self-serve**: sign up on
`developer.dhl.com`, take the key, and the task works. **Booking depends on
which DHL you mean.** For **DHL eCommerce Türkiye** it still lives behind
`apizone.mngkargo.com.tr`, an IBM API Connect portal whose request bodies are
inside a spec ZIP you can only download with an account — there is no
DHL-branded replacement, and a `book_shipment` written from a guess at those
bodies would fail at a courier rather than at a form. For **DHL Express** it
turned out to be fully public after all, and that is now its own provider
(below). Aras ships the mirror image of this (book and cancel, no tracking) for
its own reason, so "some of a carrier's tasks" is an established answer here.

**Why the provider is `dhl` and not `mng-kargo`.** DHL Group completed its
acquisition of MNG Kargo in October 2023 and the Turkish brand became **DHL
eCommerce** on 22 May 2025 — a card reading only "MNG Kargo" would look like an
integration nobody had touched in two years. But the API is DHL's **Shipment
Tracking – Unified**, which fronts fifteen-odd divisions behind one endpoint and
one key; ex-MNG parcels joined it on 21 July 2026 when `service=ecommerce-tr`
was added. Narrowing the provider to Türkiye would throw away DHL Express, Paket
in Germany and Parcel in the Netherlands for nothing — the difference is one
value in one dropdown, whose Turkish entry names MNG so it can still be found.

Three things shape the task:

- **The service is chosen per invocation and is required**, even though DHL
  treats it as optional. Left out, DHL guesses across every division it fronts —
  and a tracking number is only unique *within* one, which is what the response's
  `possibleAdditionalShipmentsUrl` admits. A guess that returns somebody else's
  shipment would write their delivery date onto your row, a failure nobody would
  ever look for. Refusing to run is much cheaper.
- **The answer is a list**, and the provider takes the entry whose id is the
  number that was asked for, falling back to the first only when DHL echoed
  nothing recognisable.
- **Nothing depends on the order of `events`.** The live API returns them
  newest-first — the opposite of every other carrier here — and the published
  contract promises neither order. DHL hands back a separate `status` object that
  *is* the current state, so the provider reads that and treats `events` as an
  unordered bag it only searches by status code.

**Pacing, and what it does not protect.** The free tier is 250 calls a day at
one per five seconds. The provider's bucket enforces the pace, not the quota —
five seconds apart is 17,000 calls a day — so a large enough fleet exhausts the
allowance first. The 429 is the real guarantee, and the engine classifies it as
busy rather than broken, so a poll that runs out at 4pm resumes instead of
tripping the breaker. Put `refresh_tracking` on a cron flow filtered to the
consignments that are not `delivered` yet: that filter is what keeps the
allowance spent on parcels still in motion.

There is a push (webhook) version of this API and it does support `ecommerce-tr`,
but access is granted through a form on the developer portal rather than by a
subscribe endpoint — there is nothing for `IntegrationWebhook.register` to call,
so polling is the whole story today.

#### DHL Express, and a carrier with no cancel

**DHL Express** is a second DHL card, and the separation is the point: `dhl`
tracks parcels through the **Shipment Tracking – Unified** API on
`api-eu.dhl.com` with a self-serve consumer key, while this books them through
**MyDHL API** on `express.api.dhl.com` with Basic auth and a contract account
number. Different host, different credential, different product. Every other
provider here is one API with one credential set, and folding two into one card
would make the capability matrix depend on which service a row happened to name.

The contract is not guesswork: DHL publishes the whole of MyDHL as OpenAPI
3.0.0 (`dpdhl-express-api-3.3.1.yaml`, v3.3.1, released 2026-06-28), and the
provider was written by reading it.

**There is no cancel task, and there cannot be one.** In all 22,726 lines of
that spec there is exactly one `delete:` operation, and it cancels a courier
*pickup* — `/pickups/{dispatchConfirmationNumber}` — not a shipment. Nothing
tagged `shipment` mentions cancel, void or delete. DHL's own guidance is to
discard an unused label: billing happens when the parcel is collected, not when
the label is made. A task named `cancel_shipment` that quietly cancelled a
collection would be worse than its absence — the label would stay valid, the
parcel would still travel, and the operator would believe otherwise. The
booking does return `dispatchConfirmationNumber`, so an operator who has to
telephone DHL about a collection has the number to quote.

Three details the spec answers and prose would not:

- **The timestamp is not ISO 8601.** `plannedShippingDateAndTime` wants
  `2019-08-04T14:00:31GMT+01:00` — the offset appended to a literal `GMT`.
  `toISOString()` produces something DHL rejects.
- **`x-version` is required**, and the spec declares it as a shared `$ref`'d
  parameter rather than beside the operation, so it is easy to miss. The
  provider pins `3.3.1` so a later DHL default cannot change what a request
  means.
- **The label is found by `typeCode`, not by position.** `documents[]` also
  carries invoices and receipts when those were requested, and taking the first
  entry would attach the wrong file — convincingly, until somebody opened it.

**To track what you booked here, use the `dhl` card with
`service=express`** — not `ecommerce-tr`. MyDHL books DHL *Express*
consignments, while the tracking card's flagship division is the Turkish
eCommerce one, so a booking made here is invisible to a poll configured for
that service. Same company, different parcel network.

**Test and production are different paths**, `…/mydhlapi/test` and
`…/mydhlapi`, with the same credentials — the opposite of EasyPost, where the
test mode is the key itself. So the environment is an explicit choice on the
connection and nothing is inferred: a wrong default here is a real consignment
and a real invoice. The picker offers test first.

The booking does **not** request a collection (`pickup.isRequested: false`).
Booking is triggered by a row write, and asking for a courier off the back of a
database insert would send a van.

#### The SOAP helper

`@backlex/integrations/soap` is the shared piece — envelope building, XML
parsing, fault handling — added when the second SOAP courier made writing it
twice the alternative. It is deliberately **not** a SOAP client: no WSDL
parsing, no schema validation, no codegen. A provider knows the operation it
wants; this turns that into a request and the answer into something it can read
fields off.

The parser refuses to be clever, and each refusal is the point:

- **No DOCTYPE processing** — it is skipped as an opaque token, which makes XXE
  structurally impossible rather than merely unlikely.
- **No custom entities** — only the five XML predefines and numeric references
  expand, so an entity-expansion bomb has nothing to recurse through.
- **No external anything** — no schema fetch, no import, no include.

An unknown entity is left exactly as it arrived rather than dropped or expanded:
dropping corrupts a value, expanding is the vulnerability, and leaving it
visible is neither. Namespace prefixes are stripped, so a courier's choice of
`soap:` or `s:` is not part of your contract, and an element occurring once
reads the same as one occurring twice via `nodeList`.

## When the provider calls you

Everything above starts on this side: we deliver, we pull, we push, we ask a
provider to act on a row. Two of those are the wrong instrument for the job.
Asking a carrier where a parcel is costs one request per parcel per interval and
is still late by however long the interval is. Noticing that one marketplace
order was cancelled costs a fourteen-day window walked every few minutes.

A provider that declares a **webhook** calls us instead.

:::note
The poll stays. Every provider's webhooks are lossy — an endpoint that was down
for an hour is an hour of events nobody will re-send — and a sync that also polls
repairs exactly that. Turning the interval down once deliveries are arriving is
your call; turning it off is rarely the right one.
:::

### It is not a second pipe

A delivery lands through the **same sync row** a pull would have used: same
collection, same field mapping, same namespaced ids. That is the whole design
decision, and it is what makes a delivery about an order the poll already
imported *update that row* instead of minting a second, emptier copy beside it.

So an endpoint is turned on **on a sync**, not created next to one:

```bash
# The marketplace sync you already have, now fed by pushes as well as polls
backlex integrations hook-on <sync-id> --events CREATED,SHIPPED,CANCELLED
```

A provider with nothing to poll — a carrier has no list of parcels to walk —
still needs a row to hold the collection, the mapping and the endpoint. That row
is `direction: inbound`. It has no schedule, and asking it to run is an error
rather than a no-op.

```bash
backlex integrations sync-create --integration <easypost-id> \
  --collection fulfillments --direction inbound \
  --match carrier_shipment_id \
  --map shipmentStatus=shipment_status \
  --map trackingCode=tracking_number \
  --map trackingUrl=tracking_url
backlex integrations hook-on <sync-id>
```

### Two ways a delivery lands

The provider declares which, because it is a fact about what the payload *is*:

| `landing` | The delivery… | Addressed by | Example |
|---|---|---|---|
| `upsert` | **is** the record | the namespaced id, exactly as a pull | a marketplace order |
| `patch` | is **about** a row you already have | the sync's `matchField` | a carrier's tracking scan |

A `patch` writes only the fields it carried. That is not a detail: the row was
built by a person and a booking task, and an upsert there would blank the
fulfillment's order, location and shipped-at date on its way past — the same bug
the [task write-back](#it-writes-back-a-patch-not-a-row) already paid for once.

`matchField` is required for a `patch` provider and refused for an `upsert` one,
where a match column would be an invitation to write to the wrong row.

### The secret is shown once

Turning an endpoint on mints a URL and a secret. The secret is returned by that
one call and **never readable again** — it is a bearer credential the provider
also holds, and a field that kept handing it back would put it in a browser
cache, a screenshot and an activity log. Lost means rotating, which keeps the
same URL:

```bash
backlex integrations hook-on <sync-id>     # again — same URL, new secret
```

How the provider uses it depends on the provider, and the connect UI says which:

| `auth` | The delivery presents the secret as… |
|---|---|
| `hmac` | a signature over the raw body, in a header |
| `header` | itself, in a header the provider lets you name |
| `basic` | the password in HTTP Basic |

Verification runs against the **raw bytes**, before anything is parsed and before
any row is touched.

### We register it where we can

Both providers that ship with this expose an API for it, so nothing has to be
pasted anywhere: `hook-on` calls the provider with the URL and the secret and
records the registration id so it can be removed again.

A registration that fails does **not** undo the endpoint. The URL works and the
secret is real; what failed is one API call. `registrationError` says what to
retry, and pointing the provider at the URL by hand is always available.

### Status codes are chosen for the provider

Not for a human reading them, and the two shipped providers make the stakes
concrete. EasyPost retries six times and gives up. Trendyol retries **every five
minutes until it succeeds**, then deactivates the webhook and emails the seller.
A 4xx for something we merely did not recognise would therefore cost an operator
their endpoint.

| Outcome | HTTP | Why |
|---|---|---|
| `applied` | 200 | rows landed |
| `unmatched` | 200 | understood; no row holds the id it named |
| `filtered` | 200 | a real event this endpoint is not subscribed to |
| `ignored` | 200 | a ping, or an event kind we do not read |
| `duplicate` | 200 | the provider is retrying something already applied |
| `rejected` | 400 | it did not present the secret — never retried, by design |
| — | 403 | the sync is turned off: stop, do not queue an hour to replay |
| — | 404 | no such endpoint |
| `failed` | 500 | ours. Retry is the right answer |

### A retry is a duplicate, not a second write

Retries are the normal case here, so the guard is a unique index on
`(sync, delivery id)` rather than a check in code — the same shape the [task
run](#it-runs-once) guard takes. The delivery id is the provider's own event id
where it sends one, and a digest of the body where it does not. That digest is
weaker in exactly one way worth stating: two genuinely identical deliveries
collapse into one. For a status change that is the same write twice, so it costs
nothing.

A `failed` row is deliberately **not** a claim. The provider is retrying because
we failed, and refusing it would strand the one delivery that most needs to land.

### What arrived, and what became of it

Every delivery is recorded with its verdict — which is the whole answer to *"the
marketplace says it sent it"*:

```bash
backlex integrations hooks <sync-id>
```

That log is also the endpoint's health: there are no `webhook_last_*` columns on
the sync, because two places recording the same fact is how they come to
disagree.

### The two providers that ship with it

**Trendyol** posts the same `{ content: [...] }` envelope its order stream
returns, so the webhook and the poll share one mapping verbatim. Its events *are*
the package statuses (`CREATED`, `PICKING`, `INVOICED`, `SHIPPED`, `DELIVERED`,
`CANCELLED`, …), which means the subscription's event filter and Trendyol's own
`subscribedStatuses` are one list — sent at registration so the narrowing happens
at their end too. There is no signature: a delivery authenticates itself with
`x-api-key` (or HTTP Basic), which is why the secret here is a bearer token
rather than a signing key.

**EasyPost** signs with `X-Hmac-Signature: hmac-sha256-hex=<hex>` over the raw
body — and NFKD-normalises the secret first, which appears in its own client
libraries and nowhere in its docs. Its webhooks are per **account**, not per
event, so there is no filter to send at registration and the narrowing is ours. A
tracker event with no `shipment_id` belongs to a parcel this workspace did not
book: that is recorded as `ignored` rather than matched on a tracking code that
could sit in any column.

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
  is the escape hatch for a consignment genuinely cancelled at the carrier. A
  [repeatable](#except-when-asking-again-is-the-point) task is the exception, and
  the one worth putting on a cron flow: it answers afresh every time.
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
| REST | `/api/admin/integrations` (+ `/catalog`, `/syncs`, `/syncs/{id}/webhook`, `/syncs/{id}/deliveries`, `/task-runs`, `/{id}/deliveries`, `/{id}/resume`, `/{id}/tasks/{task}`, `/{id}/oauth/authorize`) |
| SDK | `client.integrations.*` |
| GraphQL | `integrationCatalog`, `integrations`, `integrationSyncs`, `integrationDeliveries`, `integrationInboundDeliveries`, `connectIntegration`, `resumeIntegration`, `disconnectIntegration`, `startIntegrationOAuth`, `createIntegrationSync`, `updateIntegrationSync`, `deleteIntegrationSync`, `runIntegrationSync`, `integrationTaskRuns`, `runIntegrationTask`, `enableIntegrationWebhook`, `updateIntegrationWebhookEvents`, `disableIntegrationWebhook` |
| MCP | `integrations.catalog` / `.list` / `.connect` / `.deliveries` / `.resume` / `.disconnect` / `.oauth_authorize` / `.syncs` / `.create_sync` / `.update_sync` / `.delete_sync` / `.run_sync` / `.run_task` / `.task_runs` / `.enable_webhook` / `.update_webhook_events` / `.disable_webhook` / `.inbound_deliveries` |
| CLI | `backlex integrations …` |

`/api/admin/integrations/oauth/callback` is the provider's redirect target. It
is not part of the API you call: it always answers with a redirect into the
admin UI, because the caller is a browser mid-navigation.

`POST /api/integrations/hooks/{token}` is the one **unauthenticated** endpoint
here, and it is the provider's, not yours — the token resolves the subscription
and the endpoint's own secret authenticates the delivery.

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
