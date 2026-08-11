---
title: Flows
description: Server-side automation — a trigger plus a list of operations (log, email, push, webhook, item.create/update, condition, delay, run a function …) that run on the server when an item event fires, on a cron schedule, on a manual run, or on an inbound webhook. Admin-authored; reachable over REST, the SDK, GraphQL, MCP, and the CLI.
---

**Flows** are Backlex's server-side automation engine: a **trigger** plus an
ordered list of **operations** that run on the server when the trigger fires.
Think "if *this* happens, do *that* — log it, email someone, write a row, call
a webhook, branch on a condition, wait, then continue."

Flows are **admin-authored** — every surface that manages or runs them requires
the `admin` role. That's the trust boundary: because an admin wrote the flow,
its `item.create` / `item.update` ops **bypass the permissions DSL** and run with
full access. Don't expose flow authoring to end-users.

## Anatomy

A flow row is `{ id, name, trigger, operations, layout, active }`:

- **`trigger`** — a string that decides *when* the flow runs (see below).
- **`operations`** — a non-empty array of [operations](#operations) executed
  top to bottom. Each op can carry nested `onSuccess` / `onError` branches.
- **`layout`** — a purely presentational snapshot of the visual builder graph;
  the engine ignores it.
- **`active`** — paused flows (`active: false`) are skipped by every trigger and
  return `{ ok: false, error: "flow is paused" }` on a manual run.

## Triggers

| Trigger string | Fires when |
|---|---|
| `event:<channel>:<event>` | A matching realtime event publishes. Item events use the channel `items:<slug>`, so `event:items:posts:created` fires on a new `posts` row. `*` is a wildcard segment: `event:items:posts:*` catches create/update/delete, `event:items:*` catches every collection. |
| `cron:<pattern>` | The cron pattern is due. Standard 5-field crontab (`cron:*/5 * * * *` = every 5 min). Dispatched by the same cross-runtime [scheduler tick](/sandbox/) that runs cron functions — no extra infrastructure. |
| `schedule:<spec>` | A row's date field comes due — "three days before `due_date`". Fires **once per matching row**, with that row as `data`. See below. |
| `manual:` | Only on an explicit run (REST `…/run`, SDK `flows.run`, GraphQL `runFlow`, MCP `flows.invoke`, CLI `flows run`). |
| `webhook` | An inbound `POST /api/webhook/<flowId>` arrives. The request body becomes the flow's `data` payload. Public endpoint — guard it with a check op or a shared secret in the path. |

The matched row that changed (for event triggers) or the run payload (for
manual / webhook) lands in `data`, available to every op via templating.

### Counting from a date

A `cron` flow arrives with no row. That makes "remind me three days before an
invoice is due" inexpressible with it: the tick knows the time, not who it is
about. A `schedule` trigger is the other shape — it scans a collection and runs
the flow **once per row whose date has come due**, with the row as `data`.

The trigger string is `schedule:` followed by the spec as JSON; the admin's
trigger inspector writes it for you.

```json
{
  "collection": "invoices",
  "field": "due_date",
  "offset": { "value": 3, "unit": "days", "direction": "before" },
  "at": 540,
  "timeZone": "Europe/Istanbul",
  "where": { "status": { "_neq": "paid" } }
}
```

`field` must be a `timestamp` column — a schedule counting from a text field is
refused when you save it, because it would not misfire, it would never fire at
all.

**`at` changes what the offset means.** Left `null`, the flow fires at the same
time of day the date field itself carries, and the offset is plain elapsed time
(`minutes`, `hours`, `days`, `weeks` all allowed). Set to a minute-of-day, the
offset becomes *calendar* days and the flow fires at that wall clock in
`timeZone` — so a reminder stays at 09:00 local across a daylight-saving change
instead of drifting to 08:00 for half the year. That pairing is why `at` needs a
`days` or `weeks` offset: "two hours before, at 09:00" names two different
instants, and it is refused rather than silently resolved. A wall clock that
does not exist (the spring-forward gap) fires nothing rather than being rounded
into the next hour.

**Each row fires exactly once per instant.** The scan looks back over a
**two-day catch-up window** rather than only since the last tick, because that
window's left edge is per-process state and a serverless tick may start with no
memory of one — a restart or a deploy would otherwise drop every reminder in the
gap, silently. A `flow_schedule_fires` ledger with a unique index on
(flow, row, instant) is what keeps that from re-sending: the dispatch claims its
row *before* running, so two instances ticking together cannot both win.

Two consequences worth knowing:

- **Moving a date fires again.** The instant is part of the key, so a corrected
  due date is a new claim. A row nobody touched never re-fires.
- **Turning a schedule on does not mail the backlog.** The scan never reaches
  back past the flow's own creation, so rows that were already overdue when you
  saved it stay quiet.

### The `booking` channel

[Bookings](/booking/) fire on `booking` — `event:booking:created`,
`booking:confirmed`, `booking:cancelled`, `booking:rescheduled`,
`booking:no_show` — with the booking, plus `resourceKey` and `resourceName`, as
`data`. That is how a reminder, a calendar write-back or a deposit gets attached
to somebody picking a time.

Unlike an item event, this one is **not** on the realtime bus: it reaches flows,
webhooks, event functions and extension hooks, and nothing can subscribe to it.
A booking carries a customer's name, address and telephone number, and the
realtime plane's per-subscriber permission filter only applies to row-shaped
payloads. Use the [mirror collection](/booking/) if you want bookings on a
realtime channel — a mirrored row is a row, and gets the filter.

The channel is singular for a reason worth knowing before you name your own:
item events publish on `items:<slug>`, and three of the schema templates own a
collection called `bookings`. Had the system channel been `bookings` too, a
pattern like `event:bookings:created` would have matched both the template's
rows and the system's own events, and fired the flow twice.

## Templating

Any string field in an op is interpolated with `{{ … }}` placeholders resolved
against three roots:

- **`{{ data.* }}`** — the trigger payload (the changed row, the manual input,
  or the webhook body). E.g. `{{ data.id }}`, `{{ data.author.email }}`.
- **`{{ $user.id | $user.email | $user.roles }}`** — the auth subject that ran
  the flow.
- **`{{ $last.* }}`** — the result of the previous operation (e.g. a `request`
  op's parsed response), so ops can chain.

Missing paths render as an empty string. Interpolation recurses into objects and
arrays, so a `webhook` `body` or `item.create` `data` map is templated field by
field.

## Operations

Every op is `{ type, …fields, onSuccess?, onError? }`. `onSuccess` / `onError`
are nested operation arrays run after the op succeeds / throws.

| `type` | Does | Key fields |
|---|---|---|
| `log` | Writes a `[flow] …` line to the server log | `message` |
| `email` | Sends a templated email (renders an `email_templates` row when `templateKey` is set, else uses `subject`/`html`/`text`). `attach` carries generated documents, `ics` a calendar invite — see below | `to`, `templateKey?`, `vars?`, `subject?`, `html?`, `text?`, `attach?`, `ics?` |
| `notification` | Drops a row into the in-app `notifications` feed; `userId: null` broadcasts to admins. `push: true` also fans out to that user's devices | `title`, `body?`, `url?`, `userId?`, `push?` |
| `push` | Sends a native push to a user's registered devices (no-op if none) | `title`, `body`, `userId`, `url?` |
| `sms` | Sends an SMS through the workspace [SMS transport](/sms-messaging/). Addressed *either* by `to` (a number carried on the row) *or* by `userId` (a user's registered numbers) — exactly one, see below | `body`, `to?`, `userId?`, `from?` |
| `payment.checkout` | Opens a hosted checkout with a connected [payment provider](/payments/) and optionally writes the link onto a row. Returns `{ url, reference, … }` into `{{ $last }}` | `amount` (minor units), `currency`, `provider?` \| `providerId?`, `email?`, `description?`, `successUrl?`, `writeBack?` |
| `payment.refund` | Gives back some or all of a payment through the [provider](/payments/) that took it. Returns `{ amount, currency, status, … }` into `{{ $last }}` | one of `paymentRowId` \| `externalId` \| `reference`, `amount?` (minor units; omitted = the whole balance), `provider?` \| `providerId?`, `reason?`, `description?` |
| `document.render` | Renders a [document template](/documents/) against the row and stores the PDF. Returns `{ key, filename, size }` into `{{ $last }}` | `templateKey?` \| `html?`, `vars?`, `filename?`, `writeBack?` |
| `document.sign` | Freezes a [document](/documents/) and sends it out [for signature](/e-signature/) — one public link per signer, emailed by the op. Returns `{ id, status, signers }` (and deliberately no links) into `{{ $last }}` | `templateKey?` \| `html?`, `signers`, `title?`, `message?`, `ordered?`, `expiresInDays?`, `writeBack?` |
| `webhook` | Fires an outbound HTTP request, body JSON-encoded | `url`, `method?`, `headers?`, `body?` |
| `request` | Like `webhook` but captures the parsed response into `{{ $last }}` for later ops | `url`, `method?`, `headers?`, `query?`, `body?`, `timeoutMs?` (≤60s) |
| `function` | Invokes a saved [sandbox function](/sandbox/) by name | `name`, `input?` (defaults to `data`) |
| `run-script` | Runs inline code in the same sandbox | `code`, `timeoutMs?` (≤30s) |
| `integration` | Sends a message through a connected [provider](/integrations/#calling-an-integration-from-a-flow), addressed by kind. A provider nobody connected is skipped, not failed | `kind`, `text`, `event?`, `payload?` |
| `integration.task` | Asks a connected provider to [act on ONE row](/integrations/#asking-a-provider-to-act-on-a-row) and writes the answer back — books a shipment, notifies a marketplace. Runs at most once per row; a missing connection **fails** the run | `kind`, `task`, `collection`, `itemId`, `settings?`, `outputMapping?`, `force?` |
| `item.create` | Inserts a row into a collection (permissions bypassed) | `collection`, `data` (object or a template string parsed at run time) |
| `item.update` | Patches a row by id (permissions bypassed) | `collection`, `id`, `data` |
| `condition` | Branches: runs `then` / `else` based on a [permissions-DSL condition](/permissions/) over `data` | `filter`, `then?`, `else?` |
| `foreach` | Runs `do` once per row of a collection, with the row as `{{ $item.* }}`. See below | `collection`, `do`, `filter?`, `sort?`, `limit?` (≤500) |
| `transform` | Evaluates `value` (templated) and exposes it as `{{ $last }}` | `value` |
| `delay` | Pauses. ≤30s sleeps inline; longer is persisted to `scheduled_tasks` and resumed by the scheduler (cap 30 days) | `durationMs` |

A run stops at the first op that throws without an `onError` branch and returns
`{ ok: false, error }`. A flow that checkpointed on a long `delay` still returns
`{ ok: true }` — the remainder is queued, not failed.

### Looping over rows

Where a `schedule` trigger answers "each row, when its date comes", `foreach`
answers "each row, right now" — a weekly digest to every active subscriber, a
nightly pass over everything still unassigned.

```json
{
  "type": "foreach",
  "collection": "subscribers",
  "filter": { "active": { "_eq": true } },
  "sort": "-created_at",
  "do": [
    { "type": "email", "to": "{{ $item.email }}", "templateKey": "weekly-digest" }
  ]
}
```

The loop row is `{{ $item.* }}`, **not** `data`. `data` still holds the flow's
own trigger payload, and rebinding it per iteration would quietly change what
every `{{ data.x }}` in the body meant. (A `schedule` trigger is the opposite
case — there the row *is* the payload, so it arrives as `data` and a flow
rewritten from `event:` to `schedule:` keeps every template it already had.)

The body runs inline, which is what these rules follow from — all of them
refused when you save, not discovered at run time:

- **No `approval.request` and no `delay` over 30s inside a loop.** Both suspend
  the flow, and the continuation machinery parks "everything after this op at
  the top level" — which is not "the rest of this iteration, then the remaining
  rows". Parked, the loop would silently run once and report success.
- **No `foreach` inside a `foreach`.** The inner loop would shadow `{{ $item }}`
  with no way to reach the outer row.
- **A loop needs a body.** An empty one is a body attached to the wrong port.

`limit` caps the walk at 500 rows, which is also the default. The cap is the
default on purpose: a loop that quietly stopped at 50 would report success
having skipped the rest. When a loop does hit the cap, the server logs it —
"every overdue invoice" covering only some of them is worth saying out loud.

One more thing that bites: a filter operator the DSL does not recognise
compiles to **true**, so `$ne` where you meant `_neq` matches every row instead
of none. Flow filters are checked for that when you save.

### Putting the booking in their calendar

An `email` op with an `ics` block attaches a calendar invite. This is the
write-back that needs **nothing connected**: no OAuth, no account, and it reaches
Google Calendar, Outlook, Apple Calendar and everything else, from the
confirmation email the booking was already going to send. (The other direction —
backlex creating the event in a specific Google calendar — is a
[Calendar destination sync](/integrations/#bookings-out-to-a-calendar).)

```json
{
  "type": "email",
  "to": "{{ data.email }}",
  "subject": "Your appointment is confirmed",
  "text": "See you on {{ data.starts_at }}.",
  "ics": {
    "summary": "{{ data.service }}",
    "start": "{{ data.starts_at }}",
    "end": "{{ data.ends_at }}",
    "location": "{{ data.address }}",
    "organizerEmail": "bookings@example.com"
  }
}
```

Every field is interpolated. `summary` and `start` are required; the rest have
defaults — guests default to the message's own recipient, and an end that is
missing becomes an hour (or, for an all-day date, a day).

**The `uid` is what stops a second booking.** A calendar keys an event on it, so
re-sending with the *same* uid updates the entry the recipient already accepted,
and a fresh one books the appointment twice. It therefore defaults to the
**triggering row's id** — the one value stable across every re-run of a
row-scoped flow. Set it explicitly when the flow isn't row-scoped. Raise
`sequence` on each re-send, and use `method: "CANCEL"` to withdraw.

`organizerEmail` decides what the recipient sees: **with** it the file is a
`REQUEST` and mail clients render accept/decline; **without** it, a plain event
to add.

A `start` that renders empty or unparseable **fails the op**. The message names
the *template*, never the rendered value — it is persisted on the run's activity
row, and that value is customer data.

**Transports.** Every self-hosted transport carries the file (Resend, SendGrid,
Mailgun, SES, SMTP, console). The **managed-cloud** gateway does not yet: there
the mail is still sent and the result carries `attachmentsDropped: true`, so the
run says the invite did not travel rather than leaving the recipient to find
out. Nothing is silently lost either way — the flag is what the running
transport actually does, not what it intends to.

### Who an `sms` op texts

`push` can only reach a *platform user*, because a device has to be registered
against an account. SMS has the opposite centre of gravity: the message you most
want to automate — an appointment reminder, a delivery notice — goes to a
customer, who has no account at all. So the op carries two addressing modes and
you pick exactly one:

```json
{ "type": "sms", "to": "{{ data.phone }}", "body": "Reminder: {{ data.starts_at }}" }
{ "type": "sms", "userId": "{{ data.assigned_to }}", "body": "New job assigned" }
```

- **`to`** — a literal or templated number. It must render to **E.164**
  (`+14155552671`); anything else fails the op rather than handing the provider
  a number it will silently drop. A template that renders empty (the row has no
  phone) fails the same way — a reminder that quietly goes nowhere is worse than
  a visibly failed run.
- **`userId`** — texts every active number that user registered via
  `/api/phone-numbers`. A user with none is a **silent no-op**, matching `push`:
  an unreachable recipient shouldn't take the automation down.

Setting both, or neither, is rejected when the flow is saved. `from` overrides
the transport's configured sender id where the provider supports it.

### Billing the row that just landed

`payment.checkout` is the step that turns "an invoice was created" into "the
invoice has a payment link on it":

```json
{
  "type": "payment.checkout",
  "provider": "stripe",
  "amount": "{{ data.amount_due }}",
  "currency": "USD",
  "email": "{{ data.email }}",
  "writeBack": { "collection": "invoices", "itemId": "{{ data.id }}", "urlField": "pay_url" }
}
```

`amount` is in **minor units** — `1050` is 10.50 — matching how payments are
stored, and it is usually a template. A render that isn't a positive integer
fails the run, as does a `writeBack` target that renders empty: a live payment
link nothing records is worse than a visible failure. The error names the
offending template and never the rendered value, which would put a customer's
invoice total on the persisted `flow.run` activity row.

The link also lands in `{{ $last.url }}`, so the next step can email or text it.
Full provider matrix in [Payments](/payments/#asking-for-money).

### Refunding when the row says so

`payment.refund` is the mirror, and it pairs with a status changing — an order
moving to `cancelled`, a return being approved:

```json
{
  "type": "payment.refund",
  "reference": "{{ data.payment_reference }}",
  "reason": "requested_by_customer"
}
```

Which payment is named by **one** of `paymentRowId`, `externalId` or
`reference`. `reference` is usually the only handle a flow has: the row that was
billed knows what it was billed under and nothing else about the payment.
Naming none of the three is rejected when the flow is **saved**, because that op
can never do anything.

An **omitted `amount` means the whole remaining balance**, which is the opposite
of `payment.checkout` — there an amount is required and an unrenderable one is
fatal. Here only a *present* amount that renders to something other than a
positive integer fails the run. A `reference` that renders empty fails too:
refunding whichever payment turns up instead is not a recoverable guess.

The refundable remainder is checked against the ledger before the provider is
called, so a refund can never take the total past what was charged. The outcome
lands in `{{ $last.status }}` — Adyen and Paddle both decide asynchronously and
answer `pending`, so a following `condition` can branch on it. Provider
specifics in [Payments](/payments/#giving-money-back).
### Getting the agreement signed

`document.sign` is the step after `document.render` for anything somebody has
to sign:

```json
{
  "type": "document.sign",
  "templateKey": "lease",
  "title": "Lease {{ data.no }}",
  "signers": "{{ data.parties }}",
  "ordered": true,
  "writeBack": { "collection": "leases", "id": "{{ data.id }}", "field": "signed_doc" }
}
```

`signers` is a list **or one template that resolves to an array** — a lease
with two tenants carries its own counterparties, and `interpolate` builds
strings, so a whole-value placeholder resolves to the value itself here rather
than to `[object Object]`.

Unlike `payment.checkout`, `{{ $last }}` carries **no link**. Everything on
`$last` is readable by every op after it, and a signing link is a bearer
credential for somebody else's signature — the op sends the invitation itself,
and the `signature_request` email template is where its wording lives. Details
in [E-signature](/e-signature/).

## Surfaces

Flows are reachable from every API surface; all are **admin-scoped**.

### REST

```
GET    /api/flows            list
GET    /api/flows/{id}       get
POST   /api/flows            create   { name, trigger, operations, layout?, active? }
PATCH  /api/flows/{id}       update   (partial)
DELETE /api/flows/{id}       delete
POST   /api/flows/{id}/run   run synchronously with an arbitrary JSON body → { ok, error? }
POST   /api/webhook/{id}     public webhook trigger (only for `trigger: "webhook"` flows)
```

```bash
curl -X POST http://localhost:5173/api/flows \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  --cookie "$(your admin session cookie)" \
  -d '{
    "name": "Notify on new post",
    "trigger": "event:items:posts:created",
    "active": true,
    "operations": [
      { "type": "log", "message": "New post: {{ data.slug }} (id {{ data.id }})" },
      { "type": "notification", "title": "New blog post",
        "body": "Draft \"{{ data.slug }}\" was created.", "userId": null }
    ]
  }'
```

### SDK ([`backlex`](/sdk-and-cli/))

`client.flows.*` mirrors the REST surface. Use an **admin** API key or session —
end-user (workspace) clients get `FORBIDDEN`.

```ts
const flow = await client.flows.create({
  name: "notify",
  trigger: "manual:",
  operations: [{ type: "log", message: "hi {{ data.who }}" }],
});
await client.flows.list();
await client.flows.get(flow.data.id);
await client.flows.update(flow.data.id, { active: false });
const run = await client.flows.run(flow.data.id, { who: "world" }); // { ok, error? }
await client.flows.delete(flow.data.id);
```

### GraphQL ([reference](/graphql/#flows))

Static `flows` / `flow(id)` queries and `createFlow` / `updateFlow` /
`deleteFlow` / `runFlow` mutations, present on every workspace's schema.

```graphql
mutation Run($id: ID!, $input: JSON) {
  runFlow(id: $id, input: $input) { ok error }
}
```

### MCP ([reference](/mcp/))

Three tools for AI agents: `flows.list`, `flows.get`, and `flows.invoke`
(run a flow by id with an `input` payload).

### CLI ([reference](/sdk-and-cli/))

```bash
bun backlex flows list
bun backlex flows get <id>
bun backlex flows run <id>
bun backlex flows create --data @flow.json   # round-trips with `get`'s JSON output
bun backlex flows delete <id>
```

## Worked example

The [blog-react example](https://github.com/backlex/backlex/blob/main/examples/blog-react/README.md#bonus-react-to-new-posts-with-a-flow-server-side-automation)
walks through a flow that fires on every new post and drops an admin
notification — create a post in the app and watch the operations run.
