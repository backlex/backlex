---
title: Payments
description: Connect Stripe, Polar, Lemon Squeezy, Paddle or PayTR and mirror customers, subscriptions, invoices and payments into your collections.
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

Supported providers: **Stripe**, **Polar**, **Lemon Squeezy**, **Paddle**, **PayTR**.

Providers come in two shapes, and the difference decides what backlex can do
with them:

| Mode | Providers | Behaviour |
|---|---|---|
| `webhook` | Stripe, Polar, Lemon Squeezy, Paddle | Signed events **and** a listable object catalog, so backlex can also **reconcile** by walking the API |
| `callback` | PayTR | Posts a form-encoded result per payment; there is no catalog, so reconcile is refused with a reason rather than reporting a sync that synced nothing |

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
3. **Replays are dropped** by a unique index on `(provider_id, event_id)`. The
   insert *is* the lock, so two concurrent retries can't both apply.
4. **Rate limits** bound a token-guessing attack: 240/min per IP and 600/min per
   endpoint.

A failed signature is a `400` — providers don't retry those. A processing
failure is a `500`, which is what makes the provider's own retry schedule
replay the delivery.

## Reconcile

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
| `POST` | `/collections` | (Re-)provision the four collections |
| `GET` | `/events` | Delivery log |

Plus the public receiver: `POST /api/payments/webhook/:token`.

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
`rotatePaymentWebhookToken`, `syncPaymentProvider`,
`provisionPaymentCollections`.

**MCP** — `payments.catalog`, `payments.list`, `payments.connect`,
`payments.disconnect`, `payments.rotate_token`, `payments.sync`,
`payments.events`, `payments.provision_collections`. The synced rows are read
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

:::note
iyzico is not supported yet. Its callback carries a `token` and authenticity
comes from calling iyzico back to retrieve the payment rather than from a hash
on the request, which needs an outbound call inside the receive path. A guessed
signature format would be worse than none.
:::
