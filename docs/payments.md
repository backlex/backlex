---
title: Payments
description: Connect Stripe, Polar, Lemon Squeezy, Paddle, Adyen, Authorize.net, PayTR, iyzico or Klarna — mirror customers, subscriptions, invoices and payments into your collections, and open hosted checkouts to ask for money.
---

Connect a payment provider once, and backlex keeps a mirror of its billing
objects inside your workspace: **customers, subscriptions, invoices and
payments**, as ordinary collections you can query, filter, join, chart and
permission like anything else.

Two mechanisms keep the mirror honest:

- **Webhooks** — the provider posts to a signed, per-workspace URL and the
  matching rows are upserted immediately.
- **Reconcile** — a pull from the provider's own API that backfills history and
  repairs anything a missed delivery left stale. Runs every six hours, and on
  demand.

Going the other way, backlex can also **[ask for money](#asking-for-money)**:
open a hosted checkout for an arbitrary amount and write the payment link onto
the invoice, quote or donation row that needs paying.

Supported providers: **Stripe**, **Polar**, **Lemon Squeezy**, **Paddle**,
**Adyen**, **Authorize.net**, **PayTR**, **iyzico**, **Klarna**, plus a local
**`dummy`** provider for demos and smoke tests.

Providers differ along **two independent axes**, and conflating them is the
usual way to get this wrong.

**How trust is established** decides what backlex will accept as evidence that a
payment happened:

| Mode | Providers | Behaviour |
|---|---|---|
| `webhook` | Stripe, Polar, Lemon Squeezy, Paddle, Adyen, Authorize.net | Signs each delivery, so the request itself is the evidence |
| `callback` | PayTR | Posts a form-encoded result per payment, signed with your merchant credentials |
| `retrieve` | iyzico, Klarna | Posts an unsigned body carrying nothing but a **handle** — iyzico a payment token, Klarna an HPP session id. backlex calls the provider back with your API credentials to ask what that handle means, and records the answer |

**Whether there is a catalog to walk** decides whether [reconcile](#reconcile)
is possible at all:

| Catalog | Providers | Behaviour |
|---|---|---|
| Yes | Stripe, Polar, Lemon Squeezy, Paddle | Customers, subscriptions, invoices and payments can be paged through, so backlex can backfill history and repair drift |
| No | **Adyen**, **Authorize.net**, **Klarna**, PayTR, iyzico, `dummy` | Each payment is reported as it happens, and there is no cursor to walk — Klarna's Order Management API is addressed one order id at a time |

Having no catalog does **not** mean a provider cannot be synced. See
[Sync: two shapes](#sync-two-shapes).

Adyen is why these are two tables rather than one. It signs its notifications
exactly the way Stripe does, but it is an **acquirer** rather than a billing
platform: it authorises cards and reports what happened, and the customer /
subscription / invoice objects simply do not exist on its side. Treating
"signs its webhooks" as "can be reconciled" would send backlex off to page a
catalog that isn't there.

`GET /api/admin/payments/catalog` reports `reconcilable` and `syncMode` per
provider, so the admin UI hides **Sync now** only when it really would do
nothing.

## Why collections, not system tables

The synced data lands in real managed collections
(`payment_customers`, `payment_subscriptions`, `payment_invoices`, `payment_transactions`),
which means billing data inherits everything the platform already does:

- the [permissions DSL](/docs/permissions/) — e.g. an app user may read only
  `payment_invoices` where `customer.email == $user.email`;
- REST, [GraphQL](/docs/graphql/) and the SDK's `client.from(...)`;
- [realtime](/docs/realtime/) subscriptions and [live queries](/docs/reactive-queries/);
- [embedded BI dashboards](/docs/embedded-dashboards/) — MRR panels are just
  aggregates over `payment_subscriptions`;
- CSV export, backup/restore, revisions.

Only the connection itself (`payment_providers`) and the delivery log
(`payment_events`) are system tables.

## Connect a provider

**Admin → Payments → Connect.** You need two things from the provider:

| Provider | Credentials |
|---|---|
| Stripe | Secret (or restricted) API key + the endpoint's **webhook signing secret** (`whsec_…`) |
| Polar | Organization access token + webhook secret. Set `server: sandbox` to point at the sandbox API |
| Lemon Squeezy | API key + the signing secret you set on the webhook. Optional `storeId` scopes the reconcile pull to one store |
| Paddle | API key (`pdl_…`) + the **notification secret** (`pdl_ntfset_…`) shown once when you create the destination. Set `environment: sandbox` for the sandbox API |
| PayTR | Merchant ID, **merchant key** and **merchant salt** from the PayTR panel — the key and salt together sign the callback |
| iyzico | **API key** and **secret key** from the merchant panel. They do not verify anything inbound; they authenticate the call backlex makes to confirm each payment. Set `environment: sandbox` for `sandbox-api.iyzipay.com` |
| Adyen | **API key** (Customer Area → Developers → API credentials, with the Checkout role), the **merchant account** code, and the **HMAC key** generated alongside the webhook. On `environment: live` you also need the **live URL prefix** issued with the live credential — see [Adyen](#adyen-an-acquirer-not-a-billing-platform) |
| Authorize.net | **API login ID**, **transaction key** and **signature key**, all from Account → Settings → Security Settings → API Credentials and Keys — the transaction key authenticates outbound calls, the signature key verifies inbound webhooks, and they are different values on the same page. Plus the **account currency**, because Authorize.net states none — see [Authorize.net](#authorizenet-the-notification-that-doesnt-say-enough) |
| Klarna | **API username** and **password** from the Merchant Portal, plus the **region** and **environment** the credential was issued for and a default **purchase country**. Nothing inbound is signed; the credentials authenticate the read-back that confirms each payment — see [Klarna](#klarna-buy-now-pay-later-where-the-checkout-is-the-integration) |

For Stripe a restricted key with **read** access to customers, subscriptions,
invoices and charges is enough — backlex never writes to the provider.

Saving does two things: it stores the credentials encrypted at rest
(`AUTH_SECRET`, same as SSO and email config) and provisions the four
collections if they don't exist. You get back a receive URL:

```
https://<your-origin>/api/payments/webhook/pwh_<random>
```

Paste that into the provider's webhook settings. The token is the routing key
for an unauthenticated request, so treat it as a secret — **New URL** rotates
it (the old one 404s immediately).

Same thing from the CLI:

```bash
bun backlex payments catalog
bun backlex payments connect --provider stripe \
  --api-key sk_live_… --webhook-secret whsec_…
bun backlex payments list
```

## What gets synced

Rows are keyed by the provider's own id, namespaced so two connected providers
never collide: `stripe_cus_123`, `polar_<uuid>`, `lemonsqueezy_42`. That makes
every write an idempotent upsert — a redelivery or a re-run of the reconcile
updates in place instead of duplicating.

Money is stored in **minor units** (an integer: `2500` = €25.00) with a
separate `currency` column. No float rounding, no locale guessing.

Providers disagree about what they quote, so the normalizer converts rather
than trusting the wire value. Stripe, Paddle and PayTR already send minor units
and pass through untouched; **iyzico quotes major-unit decimals** (`"108.90"`)
and is multiplied on the way in. The scale is per-currency, not a flat ×100 —
`JPY` and `KRW` have no minor unit at all (¥500 is `500`), and the Gulf dinars
carry three digits (`KWD 1.500` is `1500`). One sum over
`payment_transactions.amount` therefore means one thing across providers.

| Collection | Notable columns |
|---|---|
| `payment_customers` | `email`, `name`, `currency`, `delinquent`, `metadata` |
| `payment_subscriptions` | `customer` (relation), `status`, `product_name`, `price_amount`, `billing_interval`, `current_period_end`, `cancel_at_period_end`, `trial_end` |
| `payment_invoices` | `customer`, `subscription`, `number`, `status`, `amount_due` / `amount_paid` / `amount_remaining`, `hosted_url`, `paid_at` |
| `payment_transactions` | `customer`, `invoice`, `amount`, `amount_refunded`, `status`, `method`, `failure_reason`, `processed_at` |

Each row also carries `provider`, `external_id` and `source_created_at`.

Provider quirks the mapper absorbs:

- **Stripe** reads the subscription off either `invoice.subscription` (older API
  versions) or `invoice.parent.subscription_details.subscription` (2025+), so
  the same code works whichever version an account is pinned to.
- **Polar** has no separate invoice object — an `order` becomes both an invoice
  row and a payment row.
- **Lemon Squeezy** never sends a `customer.*` webhook, so the buyer is derived
  from the `customer_id` / `user_email` on orders and subscriptions.

Event types backlex doesn't map (fraud warnings, checkout sessions, …) are
recorded in the log with status `skipped` and acknowledged — the provider won't
retry them.

## Extending the collections

`ensurePaymentCollections` is additive and idempotent: it creates what's
missing and never touches what exists. Add your own columns (an internal
account id, a churn-risk score) and they survive every sync — the upsert only
writes the columns it knows about.

### Slug conflicts

The four slugs are all `payment_*` prefixed — including
`payment_transactions`, which is deliberately not `payments`, because that name
is common enough in real schemas that adopting it would mean writing provider
rows into an unrelated table.

If one of the four slugs is *already* taken by a collection that isn't a sync
target (no `provider` / `external_id` columns), backlex refuses to touch it. The
connect response lists it under `collections.conflicts`, the admin page raises
it as a warning, and any event that would have written there is recorded as
`failed` with the reason rather than silently reporting success. Rename your
collection (or ours) and reconnect.

## Security model

The receive endpoint is unauthenticated by necessity — no provider will carry a
backlex session. Four things stand in for auth:

1. **The path token** is 24 random bytes and resolves the workspace.
2. **The signature must verify** over the *raw* request bytes:
   - Stripe — `Stripe-Signature: t=…,v1=…`, HMAC-SHA256 over `<t>.<body>`, with
     a 5-minute replay window. Several `v1` values are accepted so a secret
     rotation doesn't drop deliveries.
   - Polar — [standard-webhooks](https://www.standardwebhooks.com/):
     `webhook-signature: v1,<base64>` over `<webhook-id>.<webhook-timestamp>.<body>`.
   - Lemon Squeezy — `X-Signature`, hex HMAC-SHA256 over the body.
   - PayTR — base64 HMAC-SHA256 over specific form *fields*, not the raw body.
   - iyzico — **nothing to verify**; see below. Its trust comes from step 2′.

   2′. **Or the result is fetched, not accepted.** For iyzico the request body
   is discarded except for the token, and the payment is retrieved from iyzico
   with your API credentials. What lands in the ledger is iyzico's answer.
3. **Replays are dropped** by a unique index on `(provider_id, event_id)`. The
   insert *is* the lock, so two concurrent retries can't both apply.
4. **Rate limits** bound a token-guessing attack: 240/min per IP and 600/min per
   endpoint.

A failed signature is a `400` — providers don't retry those. A processing
failure is a `500`, which is what makes the provider's own retry schedule
replay the delivery.

## Sync: two shapes

**Sync now** does one of two different things, and `GET /api/admin/payments/catalog`
reports which as `syncMode`:

| `syncMode` | Providers | What it walks |
|---|---|---|
| `catalog` | Stripe, Polar, Lemon Squeezy, Paddle | The **provider's** listing of customers, subscriptions, invoices and payments |
| `refresh` | **Authorize.net**, **Klarna** | **Ours** — the ids already in `payment_transactions` |
| `null` | Adyen, PayTR, iyzico, `dummy` | Nothing. Sync returns an explanation rather than pretending |

The split exists because "has no catalog" and "cannot be synced" turned out to
be different statements. Klarna and Authorize.net expose no listing to page
through — but every id they ever gave us is sitting in our own ledger, and that
is catalog enough to re-read.

For the three with neither, replay a missed delivery from the provider's own
webhook log instead; every receive path dedupes, so a replay is safe.

### Reconcile — walking the provider's catalog

Webhooks carry the steady state; reconcile catches what they can't:

- deliveries that failed while the workspace was down,
- objects that existed *before* you connected,
- any drift.

```bash
bun backlex payments sync <provider-id>                 # inline, from the top
bun backlex payments sync <provider-id> --resume        # continue from cursor
bun backlex payments sync <provider-id> --async         # queue as a durable job
bun backlex payments sync <provider-id> --kinds customer,subscription
```

Each run walks up to 20 pages of 100 objects per record kind and stores a
per-kind cursor, so a large account finishes over several runs rather than
holding one request open. A scheduled sweep enqueues a `payments.reconcile`
[job](/docs/jobs/) per connected provider every six hours; job retry and
dead-lettering apply as usual, so a rate-limited provider backs off instead of
failing silently.

### Refresh — walking ours

A settlement-time-only integration is structurally blind to everything that
happens *after* the money arrives. A refund raised in Klarna's Merchant Portal,
an Authorize.net capture that settles overnight, an ACH debit that comes back
days later, a fraud review that resolves: none of them produce a delivery, and
for a catalog-less provider there is no listing to discover them in either.

The refresh sweep closes that. It re-reads the payments **we already recorded**,
using the same single-payment endpoint the receive path calls
(`GET /ordermanagement/v1/orders/{id}` for Klarna,
`getTransactionDetailsRequest` for Authorize.net). It needs nothing from the
provider that the integration wasn't already using.

```bash
bun backlex payments sync <provider-id>            # start the sweep over
bun backlex payments sync <provider-id> --resume   # continue the rotation
```

What it does and doesn't touch:

- **Window: 90 days.** A refund is possible for as long as the provider allows
  one, so "refresh everything" has no bound and grows with the workspace. The
  window keeps a run's cost proportional to recent trading.
- **50 rows a run, rotating.** Each row is an HTTP round trip. The sweep takes
  the next 50 ids after a stored cursor and wraps when it runs out, so a busy
  workspace still covers everything — across several runs rather than one.
  `--resume` continues the rotation; a manual **Sync now** starts over, so an
  admin chasing one payment isn't told to wait their turn.
- **`failed` and `canceled` rows are skipped.** Nothing further happens to them.
- **A payment the provider has forgotten is left standing.** A `404` counts as
  `missing` and writes nothing. Overwriting a real payment because a lookup came
  back empty would be the worst thing this could do.
- **A dead credential or a network failure stops the run**, rather than failing
  fifty rows one at a time with the same error.

The response reports `refreshed: { checked, missing }` alongside `written`.
Read `checked`: a healthy sweep re-reads unchanged payments and legitimately
writes every one of them back, so `written` on its own reads as though the
whole ledger moved.

#### Why only these two providers

The ledger upsert **replaces the row**. A refresh therefore has to restate every
money column it writes, or it blanks whatever it left out — so a provider only
qualifies once its single-payment read is known to state the whole row. Klarna's
order gives `order_amount`, `captured_amount`, `refunded_amount`, status, fraud
status and the merchant reference. Authorize.net's transaction detail is
similarly complete, and its refunds are separate transactions with their own
rows, exactly as the webhook path already files them.

**iyzico is deliberately excluded** even though `POST /payment/detail` exists and
takes the `paymentId` we store. Its refunds live per item transaction in
`itemTransactions[].refundHistory`, and a mapping written on a guess would zero
or misstate `amount_refunded` on every single pass. Adyen and PayTR have no
single-payment read at all — Adyen's history comes out as scheduled report files
and PayTR's callback is the entire surface.

#### What it still won't catch

A refund older than the window, on a workspace busy enough that the rotation
hasn't come back round. And nothing at all for the three `null` providers. If
you need certainty about a specific payment, the provider's own dashboard
remains the source of truth for post-purchase changes.

## Watching what arrives

**Admin → Payments → Recent deliveries** lists every inbound event with its
status:

| Status | Meaning |
|---|---|
| `processed` | Verified, mapped, rows written |
| `skipped` | Verified, but the event type maps to nothing |
| `duplicate` | Already seen — acknowledged, not re-applied |
| `failed` | Verified but the write failed; the provider will retry |

Start here when billing data looks stale. `bun backlex payments events --limit 50`
prints the same log.

## Asking for money

Everything above is inbound: it records payments that already happened. The
outbound half opens a **hosted checkout** and gives you a link to send the
customer — and, more usefully, writes that link straight onto the row that is
asking to be paid.

```ts
const { data } = await client.payments.checkout({
  provider: "stripe",
  amount: 10890,          // MINOR units — 108.90, matching the ledger
  currency: "TRY",
  description: "Invoice INV-42",
  customer: { email: "buyer@example.com", name: "Ada Lovelace" },
  successUrl: "https://shop.example/thanks",
  writeBack: {
    collection: "invoices",
    itemId: invoice.id,
    urlField: "pay_url",
    referenceField: "pay_ref",
  },
});
data.url;        // send the customer here
data.reference;  // comes back on the settlement
```

### `reference` is the whole point

Without it this would be a URL generator. backlex sends the id of the row that
asked for the money out with the checkout — Stripe's `client_reference_id`,
PayTR's `merchant_oid`, iyzico's `conversationId` — and the provider echoes it
back on the settlement event, where it lands on
`payment_transactions.reference`. Store the same value on your own row
(`referenceField`) and the two join:

```ts
const paid = await client
  .from("payment_transactions")
  .filter({ reference: invoice.pay_ref, status: "succeeded" })
  .list();
```

The reference contract takes the strictest limit each provider imposes, rather
than mangling the value per provider — mangling would make what comes back
differ from what went out. PayTR's `merchant_oid` sets the **alphabet**
(alphanumerics only). Authorize.net's `order.invoiceNumber` sets the **length**,
at 20; every other provider takes 48.

Left to itself backlex derives the reference from `writeBack.itemId`, stripping
the characters PayTR would refuse and trimming to the connected provider's
ceiling — so a UUID becomes its 32-hex form everywhere except Authorize.net,
where it becomes the first 20 of those. **Read `data.reference` rather than
assuming**: it is what was actually sent, and it is what will come back.

### Which providers can do this

| Mode | Providers | Behaviour |
|---|---|---|
| `adhoc` | Stripe, Adyen, Authorize.net, PayTR, iyzico, Klarna, `dummy` | Hand it an amount and get a one-off checkout. This is the shape the templates need — an invoice total exists nowhere in the provider's catalog |
| `catalog` | Polar, Lemon Squeezy, Paddle | Checkouts are opened against a **pre-existing** product/price id, with no amount parameter. Not supported yet: a checkout call is refused with a `catalog_only` explanation naming what's missing, rather than failing in a way that reads like an outage |

`GET /api/admin/payments/catalog` reports each provider's `checkoutMode`, so a
UI can hide the button rather than offer one that will be refused.

Per-provider requirements worth knowing before you wire one up:

- **Stripe** — nothing beyond the API key. Amounts go out in minor units
  verbatim, since Stripe quotes the same unit the ledger stores.
- **PayTR** — needs the customer's **email** and the **paying customer's IP**.
  The IP is folded into the token hash and scored for fraud, so backlex refuses
  rather than sending a placeholder that would work in testing and get real
  transactions declined. The REST endpoint falls back to the calling request's
  IP, which is right when a customer clicks a button in your app; a flow that
  has no request IP must pass one. TRY is sent as PayTR's `TL`.
- **iyzico** — needs the customer's **email**. Amounts are converted to
  major-unit decimals on the way out (`10890` → `"108.90"`), the mirror of what
  the inbound normalizer does. `identityNumber` defaults to iyzico's own
  documented placeholder if you don't collect one.
- **Adyen** — uses **Pay by Link**. Nothing is required beyond the API key and
  merchant account; amounts go out in minor units verbatim. Adyen has a single
  `returnUrl`, so `cancelUrl` has nowhere to go and is deliberately ignored
  rather than quietly substituted — the shopper lands on `successUrl` either
  way, with the outcome in the query string. `customer.country` is only sent
  when it really is an ISO-3166 alpha-2 code, because that same field also
  accepts a country *name* for iyzico and Adyen rejects one.
- **Authorize.net** — uses **Accept Hosted**, and is the only provider whose
  checkout is not a link on the provider's side: the API returns a form token
  that has to be POSTed, so `data.url` points at a small page backlex hosts
  which does the POST and forwards the shopper. The token is valid for 15
  minutes. Two refusals happen before any network call: a currency other than
  the one the account settles in (Authorize.net has no currency parameter, so
  charging in the account's own currency anyway would be a silent
  mispricing), and a reference longer than 20 characters.
- **Klarna** — uses the **Hosted Payment Page**, and is the only provider that
  takes two calls to open one (a payments session for the money, an HPP session
  for the page). Amounts go out in minor units verbatim. It needs a **callback
  URL** — Klarna has no dashboard webhook for HPP, so a checkout without one is
  refused rather than minted as a link nothing is listening to — and a
  **purchase country** Klarna sells in, taken from `customer.country` when that
  is an alpha-2 code and from the connection otherwise.

### The `dummy` provider

A local stand-in that settles payments without touching an acquirer — the
payment sibling of the `console` SMS and email adapters. Its checkout is a page
backlex hosts itself with **Pay** and **Decline** buttons, and paying drives the
*ordinary* receive path: signature verification, dedupe, normalize, upsert. A
test provider that bypassed any of that would be testing nothing.

Connecting it is refused unless the instance is running with `DEMO_MODE` set or
in development. A provider that records payments as succeeded is a foot-gun in
production, and unlike the console adapters this one is user-connectable from
the admin UI, so the gate lives at connect time.

The hosted link is HMAC-signed with the connection's own generated secret:
editing the amount in the URL fails before anything is recorded.

### As a flow step

The `payment.checkout` operation is where this stops being an API call and
becomes automation — *an invoice row lands, and it gets a payment link*:

```json
{
  "type": "payment.checkout",
  "provider": "stripe",
  "amount": "{{ data.amount_due }}",
  "currency": "USD",
  "email": "{{ data.email }}",
  "description": "Invoice {{ data.number }}",
  "writeBack": {
    "collection": "invoices",
    "itemId": "{{ data.id }}",
    "urlField": "pay_url",
    "referenceField": "pay_ref"
  }
}
```

The link is also returned into `$last`, so the next step can send it:
`{{ $last.url }}` in an `email` or `sms` body.

Failures are loud on purpose. An `amount` that renders to something other than a
positive integer, or a write-back target that renders empty, fails the run
rather than minting a live payment link that nothing in the workspace records.
The error names the *template* and never the rendered value — that message is
persisted on the `flow.run` activity row, and the value is a customer's invoice
total.

## API surface

Everything below hits the same service, so behaviour is identical across
surfaces.

**REST** (`/api/admin/payments`, admin-only):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/catalog` | Supported providers + their config fields |
| `GET` | `/providers` | Connected providers + delivery counts |
| `POST` | `/providers` | Connect / reconfigure |
| `DELETE` | `/providers/:id` | Disconnect (synced rows are kept) |
| `POST` | `/providers/:id/rotate-token` | New receive URL |
| `POST` | `/providers/:id/sync` | Reconcile (`async: true` to queue) |
| `POST` | `/checkout` | Open a hosted checkout, optionally writing the link onto a row |
| `POST` | `/collections` | (Re-)provision the four collections |
| `GET` | `/events` | Delivery log |

Plus the public receiver: `POST /api/payments/webhook/:token`, and the `dummy`
provider's hosted page at `GET|POST /api/payments/dummy/:token`.

**SDK**

```ts
const { providers } = await client.payments.catalog();
const { data, collections } = await client.payments.connect({
  provider: "stripe",
  config: { apiKey: "sk_live_…", webhookSecret: "whsec_…" },
});
console.log(data.webhookPath); // paste into Stripe

await client.payments.sync(data.id, { async: true });
const { data: log } = await client.payments.events({ limit: 20 });

// The synced data is just collections:
const active = await client
  .from("payment_subscriptions")
  .filter({ status: "active" })
  .sort("-current_period_end")
  .list();
```

**GraphQL** — `paymentProviders`, `paymentEvents`; mutations
`connectPaymentProvider`, `disconnectPaymentProvider`,
`rotatePaymentWebhookToken`, `syncPaymentProvider`, `createPaymentCheckout`,
`provisionPaymentCollections`.

**CLI** — `bun backlex payments checkout --amount 10890 --currency TRY
--provider stripe --write-back invoices:<id>:pay_url:pay_ref`. `connect` takes
any provider's config keys through repeatable `--set key=value`.

**MCP** — `payments.catalog`, `payments.list`, `payments.connect`,
`payments.disconnect`, `payments.rotate_token`, `payments.sync`,
`payments.checkout`, `payments.events`, `payments.provision_collections`. The synced rows are read
with the normal `collections-*` tools, so an agent sees exactly the permissions
its key grants.

## Reconfiguring safely

Reading a connection back always masks its secrets (`sk_l…3f9x`). Re-submitting
that masked value is treated as "leave the stored one alone", so editing one
field of a connection never silently destroys a key you can't recover from the
provider.

## Disconnecting

Disconnecting removes the connection and its delivery log. **The synced rows
stay** — that data describes your customers, not the provider's relationship
with you. Delete the collections yourself if you want them gone.

## Testing locally

The provider can't reach `localhost`, so use the provider's CLI tunnel
(`stripe listen --forward-to localhost:5173/api/payments/webhook/pwh_…`) or any
tunnel of your choice. The signing secret that tunnel prints is the one to
paste into the connect dialog — it differs from the dashboard endpoint's.

## Paddle is a merchant of record

Paddle is not a gateway — it is the **seller**, which is the reason to pick it.
It determines and remits VAT/sales tax itself, so a Paddle-backed product does
not need a separate tax engine (Avalara, TaxJar, Stripe Tax) to sell
internationally.

Two consequences show up in the synced data:

- **Amounts are what Paddle collected**, not vendor net. `payment_invoices.tax`
  is populated separately because it is the figure Paddle remits, not revenue.
- **Money arrives as strings** of minor units (`"11988"`), because Paddle
  refuses to round-trip currency through a float. backlex coerces to numbers on
  the way in — storing the string would break every aggregate over the column.

One Paddle *transaction* backs both an invoice row and a payment row; their ids
are distinct so the second upsert cannot overwrite the first. The reconcile path
runs pulled objects through the same normalizer as webhook events, so a
reconciled row and a webhook row are byte-identical.

## Adyen: an acquirer, not a billing platform

Adyen processes the card. It does not sell anything on your behalf, and it does
not keep a customer/subscription/invoice catalog — which shapes almost
everything below.

### Connecting

1. **Customer Area → Developers → API credentials.** Create (or reuse) a
   credential with the **Checkout** role and copy the API key. Note the
   **merchant account** code next to it — the account, not the company account.
   Opening a payment link against the wrong one is rejected.
2. **Customer Area → Developers → Webhooks.** Add a *Standard* webhook pointing
   at the URL shown on the backlex Payments card, then **Generate HMAC key** and
   paste it into the connect dialog. Unlike PayTR and iyzico, Adyen takes its
   endpoint from the dashboard rather than from each checkout — so a connection
   is not finished until you have registered that URL by hand.
3. On **live**, also copy the **live URL prefix** shown with the live
   credential (`1797a841fbb37ca7-AdyenDemo`). Adyen gives every merchant its own
   API host and there is no shared live endpoint. backlex validates the prefix
   as letters, digits and dashes before interpolating it into a URL, so a value
   carrying `/` or `@` is refused rather than redirecting your API key to
   somebody else's host.

### The HMAC key is hex

The key the Customer Area hands you is the **hex encoding of the key bytes**,
and it has to be decoded before it is used. Signing with the ASCII of that
string produces a perfectly well-formed signature that never matches anything
Adyen sends — and because both forms are printable there is nothing in the value
to tell them apart. A stored key that isn't valid hex is reported as a missing
credential, not as a signature mismatch, because that is what it is.

### The signature is inside the body, once per item

Every other webhook provider signs the raw bytes and puts the result in a
header. Adyen signs a canonical join of **eight fields** and carries the result
in `additionalData.hmacSignature` on each notification item:

```
pspReference : originalReference : merchantAccountCode : merchantReference
             : amount.value : amount.currency : eventCode : success
```

Values are escaped **backslash first, then colon** (`\` → `\\`, `:` → `\:`).
Reversing that order double-escapes the backslash it just wrote and yields a
different string, with no diagnostic beyond a rejected webhook.

One delivery may legitimately carry **several** items, so backlex verifies
**every** item and refuses the whole delivery if any single one fails. Checking
only the first would let anyone append items of their choosing to a genuine
delivery and have them recorded.

### Acknowledgement

Adyen is acknowledged with the literal body `[accepted]`. Current Adyen docs say
any `2xx` is fine and the body is ignored, but `[accepted]` was required for
years and is still honoured — so backlex sends it and covers both. An older
account that doesn't get it keeps retrying and eventually disables the endpoint,
the same trap PayTR's `OK` sets.

### Notifications are deltas, and what that means for refunds

Every other provider re-sends the **whole object** on every event, so a refund
simply restates the order with `amount_refunded` filled in. Adyen instead sends
a `REFUND` item whose `amount` is *the refunded portion* and whose
`originalReference` points back at the authorisation.

That matters because the ledger's upsert **replaces** a row rather than merging
into it. Filing a refund against the original payment's row id would overwrite
`amount` — the payment total — with the refunded portion, silently shrinking a
€100 payment to the €10 that came back. So rows are keyed by what the item's own
amount actually *means*:

| Event | Row written | Why |
|---|---|---|
| `AUTHORISATION` | Keyed on its own `pspReference` | This is the payment |
| `CAPTURE`, `CANCELLATION` | Upserts the **authorisation's** row (via `originalReference`) | Same money. A partial capture narrows `amount` to what was actually taken, which is the truer figure |
| `REFUND`, `CHARGEBACK` | Its **own** row, with `metadata.original_reference` | A different, smaller movement. `SUM(amount) WHERE status = 'succeeded'` still returns what was collected |
| `CANCEL_OR_REFUND` | Resolved by `additionalData["modification.action"]` | One event code, two outcomes — guessing would file real refunds as cancellations |
| Failed modifications (`CAPTURE_FAILED`, an unsuccessful cancellation) | **Nothing** | The authorisation still stands. The only alternatives are "leave the row alone" or "rewrite it from a payload that doesn't describe it". The event is still recorded in `payment_events`, so the failure stays visible |

Anything else — `REPORT_AVAILABLE`, `NOTIFICATION_OF_CHARGEBACK`, event codes
Adyen adds later — is logged as an event and writes no row.

Amounts need no conversion in either direction: Adyen quotes minor units, which
is what the ledger stores.

### Reconcile does not apply

Adyen exposes no object catalog **and** no way to re-read one payment — its
history comes out as scheduled report files rather than an API — so it is one of
the three providers with no `syncMode` at all. `POST /providers/{id}/sync`
returns `written: 0` with an explanation rather than pretending to have synced,
and the admin UI hides the button entirely. If a delivery is missed, replay it from
**Customer Area → Developers → Webhooks → the delivery log**; backlex dedupes on
`pspReference`, so a replay is safe and idempotent.

## Authorize.net: the notification that doesn't say enough

Authorize.net signs its webhooks the way Stripe does — an HMAC over the raw body
in a header — so the delivery *is* the evidence. What is different is how little
that delivery contains, and three of its quirks are silent rather than loud.

### The signing key is plain text, and SHA-512

`X-ANET-Signature: sha512=<hex>` over the raw body, keyed by the **Signature
Key** from the merchant interface, used as its literal characters.

That is the opposite of Adyen, whose HMAC key is the hex *encoding* of key bytes
and must be decoded first. Both keys are long printable hex-looking strings, so
nothing about the value tells you which it is — and using the wrong form
produces a perfectly well-formed signature that matches nothing. If every
delivery is rejected with `signature_mismatch`, this is the first thing to
check; the second is that you pasted the **signature key** and not the
**transaction key**, which sits directly above it on the same page.

The algorithm is pinned rather than read off the header: a delivery announcing
`sha256=` is refused as malformed, not verified against a weaker digest.

### There is no currency. Anywhere

Not on a transaction, not on a notification, not in Authorize.net's XSD. A
merchant account settles in exactly one currency, so an amount is a bare
decimal.

This is why the connect dialog asks for the **account currency**. Every amount
that arrives is filed under it, and every checkout is refused if it asks for
anything else — Authorize.net has no currency parameter to send, so charging in
the account's own currency regardless would be a mispricing nothing downstream
could detect.

Amounts also arrive in **major units** (`45.00`), unlike Adyen and Stripe, so
they are converted to the minor units the ledger stores.

### The invoice number is fetched, not received

The notification carries a transaction id, an amount and a response code — and
no merchant reference. `refId`, the obvious place for one, is echoed on the API
*response* and is not stored against the transaction, so it can never come back
on a later event. Only `order.invoiceNumber` persists, and it is not in the
webhook.

So for every payment notification backlex makes a second call —
`getTransactionDetailsRequest` — and lifts the invoice number, card type,
settlement status and (for a refund) the original transaction it reverses onto
the row. Without it a payment would arrive with an amount and no idea what it
paid for, which is exactly the failure [`reference`](#reference-is-the-whole-point)
exists to prevent. It is also why the reference is capped at 20 characters for
this provider: that is all `order.invoiceNumber` will hold.

That second call is **best-effort**. The HMAC already proved the delivery is
real, so a lookup that fails still records the payment — losing the invoice
number rather than the money event. Failing hard instead would mean one wrong
credential 500-loops every delivery until Authorize.net disables the endpoint.
The failure is logged as `payments.authorizenet_detail_unavailable`.

### Which event writes which row

| Event | Row written | Why |
|---|---|---|
| `authorization.created` | Keyed on the transaction id, status `pending` | Authorised, not captured. The money is held, not taken |
| `authcapture.created`, `capture.created`, `priorAuthCapture.created` | Upserts the **same** transaction id | Authorize.net reuses the id when an authorisation is captured, so no `originalReference` bookkeeping is needed |
| `void.created` | Same id, status `canceled` | |
| `refund.created` | Its **own** row | A refund is a new transaction whose amount is the refunded portion. Filing it against the payment would overwrite a $45 payment with the $10 that came back |
| `fraud.held` / `.approved` / `.declined` | `pending` / `succeeded` / `failed` | A hold is the gateway asking for a human, which is neither a success nor a failure yet |
| `customer.subscription.*` | A `payment_subscriptions` row | |
| `customer.*`, `customer.paymentProfile.*` | **Nothing** | The payload carries an id and no email or name, so there is no customer row worth writing |

The response code decides the verdict regardless of the event name: `1` is
approved, `4` is held for review (recorded as `pending`), anything else is
`failed`.

### Two things about their API worth knowing

- **Errors come back as HTTP 200.** The verdict is `messages.resultCode`, so the
  status code is never trusted on its own.
- **Responses begin with a UTF-8 BOM**, which `JSON.parse` rejects while naming
  a character that does not appear when the body is printed. It is stripped
  before parsing.

### The checkout is a form POST, not a link

Accept Hosted returns a **form token** which has to be POSTed to
`accept.authorize.net` (or `test.authorize.net` on sandbox). There is no URL to
hand anybody, so `data.url` points at a small page backlex hosts —
`/api/payments/authorizenet/<connection-id>` — that performs the POST and
forwards the shopper. The destination host comes from the connection's own
environment, never from the link, so the page cannot be used as a form relay;
and it ships its own Content-Security-Policy, because the app-wide
`form-action 'self'` would otherwise block the cross-origin submit outright.

Note the routing key: the **connection id**, not the webhook token. This URL
goes out in a payment link and is read by every customer asked to pay, while
the webhook token is the shared secret guarding your unauthenticated receive
endpoint — putting it in front of payers would spend it. The connection id is
an unguessable UUID that grants nothing on its own.

The token is valid for 15 minutes.

One diagnostic worth knowing before you lose an afternoon to it: Authorize.net
validates the **host** of your `successUrl` and reports a failure as

> Invalid Setting Value. hostedPaymentReturnOptionsurl must begin with http://
> or https://.

which blames the scheme. It is not the scheme. `http://localhost:5173/…` and
reserved-TLD hosts like `https://shop.example/…` are both refused with that
message while `https://example.com/…` is accepted, so testing a checkout
locally needs a real public return URL even though nobody is going to visit it.

### Sync re-reads what we recorded

Authorize.net's reporting endpoints are batch-scoped —
`getTransactionListRequest` wants a settlement batch id — so there is no cursor
over the account to page through, and reconcile in the catalog sense is
impossible.

`Sync now` therefore runs the [refresh sweep](#refresh--walking-ours) instead:
it re-reads the transactions already in `payment_transactions` with
`getTransactionDetailsRequest`. That is worth more here than for most providers,
because `transactionStatus` is a field the **notification never carries** —
`capturedPendingSettlement` becoming `settledSuccessfully` overnight, a void
raised in the merchant interface, or a `returnedItem` (an ACH debit bouncing
days later) are all otherwise invisible.

A missed delivery can still be replayed from **Account → Settings → Webhooks →
Notifications**; backlex dedupes on `notificationId`.

## PayTR: callback-style, and the `OK` requirement

PayTR posts `application/x-www-form-urlencoded` to the callback URL and signs
specific **fields** rather than the body:

```
hash = base64(HMAC-SHA256(merchant_oid + merchant_salt + status + total_amount, merchant_key))
```

Two things are easy to get wrong and both fail quietly:

- **The endpoint must answer with the literal body `OK`.** Anything else —
  including a perfectly good JSON success — is read as a failure. PayTR retries
  on a schedule and eventually disables the merchant's notification URL, while
  the logs on your side look entirely healthy. backlex sends the right ack
  automatically.
- **A repeated signed field is refused.** `merchant_oid`, `status` and
  `total_amount` may each appear once. Without that rule a genuine
  `status=failed` callback could be replayed with `&status=success` appended:
  the hash still covers the first value while a naive parser records the last.

`merchant_oid` is your own order id and doubles as the dedupe key, since PayTR
re-sends until it gets `OK`. Amounts are already in kuruş and are stored as-is.

**Reconcile does not apply.** PayTR exposes no object catalog, so
`POST /providers/:id/sync` returns an explanatory error instead of pretending.

## iyzico: retrieve-style, and why the callback body is ignored

iyzico's Checkout Form posts to your callback URL with a single field, `token`,
and **no signature over it**. There is nothing on that request to verify — so
backlex does not try.

Instead the token is the only thing carried forward. backlex calls
`/payment/iyzipos/checkoutform/auth/ecom/detail` with your API key and secret
(IYZWSv2 request signing) and records what iyzico reports. The consequence is
worth stating plainly:

- **Everything else in the POST is thrown away.** A caller who finds your
  callback URL and posts `paymentStatus=SUCCESS&paidPrice=999999` gets nothing:
  the amount, the status and the payment id all come from iyzico.
- **A forged or foreign token yields no record.** iyzico answers `status:
  failure` for a token that is not yours, and that is treated as a verdict —
  refused, not retried.
- **An unreachable iyzico is a `500`, not a rejection.** Calling a network blip
  a forgery would drop a payment that really settled, so the delivery is failed
  and iyzico's own retry gets a turn.

Two statuses in the response mean different things and conflating them files
every decline as a completed payment:

| Field | Means |
|---|---|
| `status` | whether the **API call** worked |
| `paymentStatus` | whether the **card was charged** (`SUCCESS` / `FAILURE`) |

The recorded amount is `paidPrice`, not `price` — `paidPrice` includes the
installment surcharge and is what the customer was actually charged. iyzico
quotes it as a major-unit decimal (`"108.90"`), so it is converted to minor
units (`10890`) before it reaches the ledger — see the note under
[Where the data lands](#where-the-data-lands).

Set the callback URL on your `checkoutFormInitialize` request (iyzico takes it
per-request rather than from a panel setting). It is the same
`/api/payments/webhook/<token>` path the connect dialog shows.

**Reconcile does not apply, and neither does the refresh sweep.** iyzico exposes
no object catalog to page through, so `sync` is refused with a reason rather than
reporting a clean empty sync.

It is the one provider that *nearly* qualifies for
[refresh](#refresh--walking-ours): `POST /payment/detail` exists and takes the
`paymentId` stored in `external_id`. It is excluded because the ledger upsert
replaces the row, and iyzico reports refunds per item transaction in
`itemTransactions[].refundHistory` — a mapping written on a guess would zero or
misstate `amount_refunded` on every pass. Adding it needs that shape verified
against a real refunded payment first, not inferred.

## Klarna: buy-now-pay-later, where the checkout *is* the integration

Klarna is the second `retrieve` provider, and the first one where connecting it
inbound-only would have been close to pointless. It is a BNPL product: its value
is at the moment somebody is asked to pay, so a connection that could only watch
payments backlex never initiated would be watching an empty room. Everything
below assumes you are using it through
[Asking for money](#asking-for-money).

### Connecting

| Field | Where it comes from |
|---|---|
| **API username** | Merchant Portal → Settings → Klarna API credentials. Looks like `PK12345_0a0a0a0a` |
| **API password** | Generated with the username and shown once |
| **Region** | `europe`, `north_america` or `oceania` |
| **Environment** | `playground` or `production` |
| **Default purchase country** | The market to sell in when a checkout carries no customer country |

**Region is a deployment, not a routing hint.** Klarna runs one API per region
(`api.klarna.com`, `api-na.klarna.com`, `api-oc.klarna.com`, each with a
`playground` twin) and a credential authenticates against exactly one of them.
Pointing a European credential at the North American host fails as a `401` that
reads precisely like a wrong password.

A connection that has not chosen defaults to the **playground**, the opposite of
every other provider here. Klarna's credentials are region- *and*
environment-scoped, so an unconfigured connection is far likelier to be a
merchant mid-setup than a live account, and the cheaper way to be wrong is not
to point it at production.

**Purchase country is not a formality.** It decides which BNPL plans the
consumer is offered, and Klarna refuses a market the merchant account is not
enabled for — so the field is a dropdown of the countries Klarna sells in rather
than a text box where a typo becomes a rejected checkout with a message about
payment methods. A `customer.country` on the checkout call overrides it, but
only when it really is an ISO-3166 alpha-2 code: that same field also accepts a
country *name* for iyzico, and Klarna rejects one.

### The checkout takes two calls

Klarna is the only provider here whose hosted checkout is not a single request:

1. **`POST /payments/v1/sessions`** — the money. A Klarna Payments session
   carries the amount, currency, market and `merchant_reference1`.
2. **`POST /hpp/v1/sessions`** — the page. It wraps session (1) in something
   that has a URL, because a bare Klarna Payments session is meant to be
   rendered by the merchant's own JavaScript widget and has no page to send
   anybody to.

Amounts go out in **minor units verbatim** — Klarna quotes the same unit the
ledger stores, so unlike iyzico there is no conversion. backlex synthesises a
single order line for the whole total, with tax reported as zero rather than
guessed: it is handed a gross figure with no breakdown, and inventing a rate
would put a wrong number on the consumer's Klarna statement.

### `place_order_mode` is what makes it a payment

The HPP session is opened with `options.place_order_mode: "CAPTURE_ORDER"`.

Left at Klarna's default (`NONE`), the consumer is *authorised* and the merchant
is then expected to place the order themselves using an authorization token.
Nothing in backlex is listening for that, so the failure would be a quiet one:
the customer sees a confirmation screen, the authorisation expires days later,
and no money ever moves. `CAPTURE_ORDER` has Klarna place and capture the order —
and it is also why the settlement carries an `order_id` for the amounts to be
read off.

### Settlement, and why the callback proves nothing

Klarna reports to the `status_update` URL carried on the HPP session — there is
no dashboard-configured webhook, so a checkout opened without a callback URL is
refused rather than minted as a link nothing is listening to. The delivery looks
like this, and it is **not signed**:

```json
{
  "event_id": "270b2adc-…",
  "session": { "session_id": "35bde117-…", "status": "COMPLETED", "updated_at": "…" }
}
```

Klarna's own documentation tells merchants to put a one-time token in that URL,
because there is nothing to verify. backlex therefore treats it exactly the way
it treats iyzico's: **only the `session_id` is carried forward**, and the truth
is fetched back over Basic auth —
`GET /hpp/v1/sessions/<id>`, then `GET /ordermanagement/v1/orders/<order_id>`.

- **Everything else in the POST is thrown away.** Posting a `captured_amount` of
  your choosing records nothing.
- **A session id that is not yours 404s**, and that is a verdict — refused, not
  retried.
- **The session id is validated before it is used.** Unlike iyzico's token,
  which travels in a request body, Klarna's goes into a URL path that carries
  your credentials — so a value with a separator in it would choose which
  endpoint they are sent to. Anything that is not a plain id is refused. The
  same check is applied to the `order_id` Klarna hands back, because that
  decides the second URL.
- **A completed session whose order cannot be read is a `500`.** We know a
  payment happened and not what it was worth; filing it at a guessed figure is
  worse than filing it a minute later off Klarna's retry.

### Which deliveries write a row

Klarna calls `status_update` on **every** transition, and most of them are not
money:

| Session status | Row written |
|---|---|
| `COMPLETED` (with an order) | The payment, from the order's own figures |
| `IN_PROGRESS`, `FAILED`, `BACK`, `ERROR` | None — these are retryable; the consumer may still pay |
| `CANCELLED`, `TIMEOUT`, `DISABLED` | None — an abandoned checkout is not a payment |

Interim deliveries are acknowledged with a **`200`**. Answering `4xx` to a
perfectly correct notification would show up as a failing endpoint in Klarna's
dashboard. They are still recorded in the delivery log, which is where to look
for "did anyone open it".

Order status maps onto the ledger like this:

| Klarna | `payment_transactions.status` |
|---|---|
| `CAPTURED`, `PART_CAPTURED` | `succeeded` |
| `AUTHORIZED` | `pending` — the money is reserved, not taken |
| `CANCELLED` | `canceled` |
| `EXPIRED` | `failed` |
| any, with `fraud_status: REJECTED` | `failed` |

The recorded amount is `captured_amount` when there is one, falling back to
`order_amount` — an authorised-not-captured order reports `captured_amount: 0`,
and filing its full total as money received would overstate the ledger.
`merchant_reference1` is what the checkout travelled out with, and it is what
lands on `payment_transactions.reference`.

**Refunds issued later do not push.** `status_update` fires on the HPP
*session*, which is finished once the order is placed; a refund raised
afterwards in the Merchant Portal changes the order and notifies nobody.

**Sync catches them anyway.** Klarna's Order Management API is addressed one
`order_id` at a time, so there is no catalog to reconcile against — but the
order ids are all in `payment_transactions`, and the refresh sweep re-reads
them. See [Refresh — walking ours](#refresh--walking-ours) for the window and
what it still misses.
