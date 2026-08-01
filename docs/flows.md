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
| `manual:` | Only on an explicit run (REST `…/run`, SDK `flows.run`, GraphQL `runFlow`, MCP `flows.invoke`, CLI `flows run`). |
| `webhook` | An inbound `POST /api/webhook/<flowId>` arrives. The request body becomes the flow's `data` payload. Public endpoint — guard it with a check op or a shared secret in the path. |

The matched row that changed (for event triggers) or the run payload (for
manual / webhook) lands in `data`, available to every op via templating.

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
| `email` | Sends a templated email (renders an `email_templates` row when `templateKey` is set, else uses `subject`/`html`/`text`). `ics` attaches a calendar invite — see below | `to`, `templateKey?`, `vars?`, `subject?`, `html?`, `text?`, `ics?` |
| `notification` | Drops a row into the in-app `notifications` feed; `userId: null` broadcasts to admins. `push: true` also fans out to that user's devices | `title`, `body?`, `url?`, `userId?`, `push?` |
| `push` | Sends a native push to a user's registered devices (no-op if none) | `title`, `body`, `userId`, `url?` |
| `sms` | Sends an SMS through the workspace [SMS transport](/sms-messaging/). Addressed *either* by `to` (a number carried on the row) *or* by `userId` (a user's registered numbers) — exactly one, see below | `body`, `to?`, `userId?`, `from?` |
| `payment.checkout` | Opens a hosted checkout with a connected [payment provider](/payments/) and optionally writes the link onto a row. Returns `{ url, reference, … }` into `{{ $last }}` | `amount` (minor units), `currency`, `provider?` \| `providerId?`, `email?`, `description?`, `successUrl?`, `writeBack?` |
| `webhook` | Fires an outbound HTTP request, body JSON-encoded | `url`, `method?`, `headers?`, `body?` |
| `request` | Like `webhook` but captures the parsed response into `{{ $last }}` for later ops | `url`, `method?`, `headers?`, `query?`, `body?`, `timeoutMs?` (≤60s) |
| `function` | Invokes a saved [sandbox function](/sandbox/) by name | `name`, `input?` (defaults to `data`) |
| `run-script` | Runs inline code in the same sandbox | `code`, `timeoutMs?` (≤30s) |
| `item.create` | Inserts a row into a collection (permissions bypassed) | `collection`, `data` (object or a template string parsed at run time) |
| `item.update` | Patches a row by id (permissions bypassed) | `collection`, `id`, `data` |
| `condition` | Branches: runs `then` / `else` based on a [permissions-DSL condition](/permissions/) over `data` | `filter`, `then?`, `else?` |
| `transform` | Evaluates `value` (templated) and exposes it as `{{ $last }}` | `value` |
| `delay` | Pauses. ≤30s sleeps inline; longer is persisted to `scheduled_tasks` and resumed by the scheduler (cap 30 days) | `durationMs` |

A run stops at the first op that throws without an `onError` branch and returns
`{ ok: false, error }`. A flow that checkpointed on a long `delay` still returns
`{ ok: true }` — the remainder is queued, not failed.

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
