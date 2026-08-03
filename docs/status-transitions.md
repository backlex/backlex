---
title: Status transitions
---

A **lifecycle** says which value a status field is allowed to move to, from
where it is now. Declare it once on the field and backlex enforces it on every
write surface — REST, GraphQL, the SDK, the CLI, batch, CSV import, and the
flows, bookings and payment webhooks that write your collections server-side.

```json
{
  "name": "status",
  "type": "text",
  "interface": "dropdown",
  "options": {
    "choices": [
      { "value": "draft" }, { "value": "open" },
      { "value": "paid" },  { "value": "void" }
    ]
  },
  "transitions": {
    "initial": ["draft"],
    "allow": [
      { "from": "draft", "to": "open", "label": "Send" },
      { "from": "open",  "to": "paid", "label": "Mark paid", "roles": ["finance"] },
      { "from": ["draft", "open"], "to": "void",
        "requires": ["void_reason"], "label": "Void" }
    ]
  }
}
```

That invoice can no longer go back to `draft` once it is `paid`, cannot skip
straight from `draft` to `paid`, and cannot be voided without a reason.

## Why this needed a new mechanism

Twenty-six of the twenty-seven schema templates carry a status dropdown — 156 of
them across 152 collections — and they are not labels, they are lifecycles:
`draft → open → paid → void`, `requested → approved → received → completed`,
`pending → approved → denied → cancelled`. A hundred and nineteen of them
contain a state a row is not supposed to come back out of.

Nothing could express that. Choice membership is already enforced, so
`status: "banana"` is a 422 — but `paid → draft` is two legal values in
sequence. And every other rule in backlex judges the row a write would
*produce*:

| Mechanism | Sees |
|---|---|
| `validation.rule` ([field validation](/docs/field-validation)) | the proposed row |
| `conditions` ([field conditions](/docs/field-conditions)) | the proposed row |
| permission `condition` ([permissions](/docs/permissions)) | the row as stored, to decide if you may write it at all |

None of them can see **the value the field is changing from**. A transition
spec is that missing half.

## Shape

### `allow` — the moves

Each rule is `{ from, to, roles?, requires?, label? }`.

- **`from` / `to`** — a value, a list of values, or `"*"` for any. A move that
  no rule matches is refused.
- **`roles`** — role names allowed to make this move. Omit and anyone who may
  update the row may make it.
- **`requires`** — sibling fields that must hold a value for the move to be
  accepted. Judged against the row *after* the write, so filling the field in
  the same request counts.
- **`label`** — the verb for the button that makes the move ("Mark paid").
  Display only.

Several rules may cover one edge; the caller gets the benefit of any of them.

### `initial` — where a row may start

Omit it and a new row may be created in any of the field's values. It also
governs a row whose status is still empty (see below).

### Terminal states

There is no `terminal` flag. A value that no rule names as a `from` is final by
construction — which is also how the admin draws it, and what
`GET /api/items/{slug}/{id}/transitions` reports as `terminal: true`.

## Rules the checker follows

**Restating the current value is not a move.** A client that PATCHes the whole
row back, status included, is not transitioning anything and is never refused
for it.

**An empty status is an initial assignment, not a move.** A row with no value
yet has no `from` to judge, so filling it is checked against `initial`. This
matters when you add a lifecycle to a collection that already has rows: every
existing row keeps whatever value it has, and one with none is not stranded.

**Clearing a status is not a move either.** There is no `to` to match a rule
against; use `required` if a status must always be present.

**A value that is no longer a choice can still be moved out of** — but only by a
rule whose `from` covers it, which in practice means `"*"`. Worth adding one if
you retire a choice while rows still hold it.

## The graph is integrity; the roles are permission

The two halves of a rule have different reach, and the difference is
deliberate.

The **graph** is a property of the data. An invoice going back to draft is wrong
no matter what did it, so it is enforced on writes that bypass permissions
entirely: a flow's `item.update`, a booking, a payment webhook, an approval
resolution.

The **roles** are a property of the caller. Those same server-authored writes
have no user to judge, so the role gate does not apply to them — a flow that
moves an invoice to `paid` is not refused for not being in `finance`.

One path is exempt from both: **restoring data is not writing it.** Backup
restore, `backlex import-db` and template seeding load rows that are already in
whatever state they are already in, so they do not replay the lifecycle.

## What a refusal says

An illegal move is `422 VALIDATION`; a move you are not permitted to make is
`403 FORBIDDEN`. Both carry structured `details`:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Field \"status\": Moving to \"void\" requires \"void_reason\"",
    "details": {
      "field": "status", "from": "open", "to": "void",
      "refusal": "missing_fields", "missing": ["void_reason"]
    }
  }
}
```

`refusal` is one of `not_allowed`, `forbidden_role`, `missing_fields`,
`not_initial`. A row that is merely incomplete reports `missing_fields` rather
than `not_allowed`, because "you cannot do this" and "you have not filled this
in yet" are different things to tell an operator.

## Asking what a row can do next

```http
GET /api/items/invoices/{id}/transitions
```

```json
{
  "data": [{
    "field": "status",
    "current": "open",
    "terminal": false,
    "moves": [
      { "to": "paid", "label": "Mark paid", "allowed": true },
      { "to": "void", "label": "Void", "allowed": false,
        "refusal": "missing_fields", "missing": ["void_reason"],
        "reason": "Moving to \"void\" requires \"void_reason\"" }
    ]
  }]
}
```

Refused moves are **included**, with the reason. A button that is visibly
disabled because a field is empty tells an operator what to do next; a button
that is simply absent tells them nothing.

The answer is computed for the calling identity, so a move gated on a role you
do not hold comes back `allowed: false`.

On the other surfaces:

```ts
await backlex.from("invoices").transitions(id);           // SDK
```
```graphql
query { invoicesTransitions(id: "…") }                     # GraphQL
```
```bash
bun backlex items transitions invoices <id>                # CLI
```
```
items.transitions { collection, id }                       # MCP
```

The same function answers all five — `allowedMoves` from
`@backlex/db/transitions` — which is also what the admin's item form calls to
build its dropdown. The form cannot offer a move the server will refuse.

## Reacting to a move

Every accepted move announces itself to the automation plane under an event
whose name carries the edge:

```
items:<collection>:transition:<field>:<from>:<to>
```

Because flow triggers match on whole colon-separated segments and support `*`,
that gives you edge-level triggers with nothing to configure:

| Trigger | Fires on |
|---|---|
| `event:items:invoices:transition` | every move on any lifecycle field |
| `event:items:invoices:transition:status` | every move of `status` |
| `event:items:invoices:transition:status:*:paid` | anything reaching `paid` |
| `event:items:invoices:transition:status:open:paid` | exactly that edge |

This is the automation that was not previously expressible: an `updated`
trigger fires on every save and cannot tell whether the status changed, only
what it now is.

Webhooks and integrations receive the same event. It is deliberately **not** put
on the realtime bus — subscribers already get the row as `updated`, and the bus
carries the three verbs a row can undergo, not a lifecycle vocabulary.

Server-authored writes (a flow's own `item.update`, bookings, payment syncs)
publish no item events at all, transitions included. That is existing behaviour,
and it is what stops one flow's write triggering the next in a loop.

## Editing one in the admin

Add or edit a **Dropdown** (or **Radio Buttons**) field and open the
**Lifecycle** tab. The moves are a matrix — one row per value the record is in,
one box per value it may go to — so a row of empty boxes visibly *is* a final
state and a column nobody ticks visibly *is* unreachable. Click an allowed move
to give it a label, a role gate or required fields.

In the item form, the status dropdown then offers only the moves that are open
from where the record actually is; the rest are greyed with a short reason. On a
Kanban board, dropping a card into a column the record cannot reach is refused
before anything moves.

## Restrictions

A field with `transitions` must be `text` with `options.choices` — a value set
that is not fixed has no lifecycle to describe. It cannot also be `computed`,
`rollup` or `sequence` (the server already owns those values) or `localized` (a
record is not in a different state in French).

Choice values may not contain `:` on a lifecycle field, because the value names
the flow trigger the move fires.

Every `from` / `to` / `initial` value is checked against the field's choices at
save time, and every `roles` name against the workspace's roles — a rule gated
on a role that does not exist is not a stricter rule, it is a move nobody can
ever make.

## What it does not do

**Reachability is not checked.** You can describe a state nothing leads to; the
graph is yours to draw.

**There is no history of moves** beyond what you already get: the
[activity log](/docs/audit-logs) records the write and [revisions](/docs/querying)
keep the prior snapshot.

**A move cannot run an action inline.** Use the transition event and a
[flow](/docs/flows) — that keeps the write fast and the side effect retryable.
