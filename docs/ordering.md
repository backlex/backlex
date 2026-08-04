---
title: Order fields
---

An **order field** is the place a row holds in a list somebody arranged by hand:
the third lesson of a module, the second stage of a pipeline, the item that sits
at the top of a menu. You declare an ordinary `integer` column as one, and
backlex maintains it — new rows go to the end, and a row is moved by saying where
you want it, not by renumbering its neighbours.

```json
{
  "name": "position",
  "type": "integer",
  "order": { "scope": "module" }
}
```

## Why this isn't something the caller can do

Twenty-eight collections across thirteen of the twenty-seven schema templates
carry a `position` integer, and twenty-five of those collections declare
`defaultSort: "position"` on top of it — the third most common default sort in
the whole catalog, after `name` and `-created_at`.

Every one of them defaulted to `0`.

So the schema said "these are in an order somebody chose" and then made that
impossible to hold:

- **Every new row landed on the same number.** A sort over a column where most
  values are equal is not an order; it is whatever the query planner returned,
  and it can differ between two identical requests.
- **Nothing renumbered.** Putting a lesson between the third and the fourth meant
  editing the fourth, the fifth, and everything after it, by hand, one row at a
  time — and getting one wrong silently reordered the rest.
- **The admin could drag-reorder its schema fields, its collections, its list
  columns and its form blocks** — but not the rows whose entire purpose is to be
  in an order.

The client-side fix is "read the list, renumber it, write every row back", which
is a write per row, races with anyone else doing the same, and leaves the list
half-renumbered if it fails in the middle.

## Storage

The column stays exactly what it was: an `integer`, sortable, filterable,
indexable. There is **no migration** — declaring an existing `position` column as
an order field is a metadata change, which is why all twenty-eight template
columns converted at once.

An order field is a spec on an integer, not a new field type, for the same reason
a document number is a spec on a text column: a new type would buy nothing (the
storage is identical) and would cost an entry in every exhaustive type mapping in
the codebase.

## Lists and scopes

`order.scope` names the column that splits the collection into separate lists.
With `scope: "module"`, each module's lessons are numbered 1, 2, 3
independently. Without it, the whole collection is one list — which is right for
a top-level arrangement (pipelines, SLA policies, folders) and wrong for anything
nested, where a single numbering makes two parents' children interleave.

A scope may be a `relation`, `text`, `integer`, `uuid` or `boolean` column. A
`text` dropdown is deliberately allowed: ordering cards *within* a Kanban column
is a partition by status, and it is the same operation.

It is one column, not a list. A deeper partition ("within the course, then within
the module") has a real answer — order within the **nearest** parent — and
supporting two would mostly serve schemas that had not picked one.

Rows whose scope value is `NULL` are one list together, not one list each.

## Creating

A create that says nothing about the position **appends** it to the end of its
list:

```bash
curl -X POST /api/items/lessons -d '{"name":"Setup","module":"mod_1"}'
# → { "data": { "id": "…", "name": "Setup", "module": "mod_1", "position": 4 } }
```

The position comes back in the response, so a client does not have to re-read to
learn where its row went.

A create that **states** a position keeps it, verbatim. A CSV import, a restore
and a template's sample rows all carry their own arrangement, and overruling them
would scramble exactly the data that was already in order.

Under the hood the append is a subquery inside the `INSERT`, not a number the
server read first. The database evaluates it at insert time, so the second row of
a batch sees the first — a fifty-row import numbers 1…50 rather than giving every
row the same 1.

## Moving

```bash
curl -X POST /api/items/lessons/reorder \
  -d '{"field":"position","id":"les_9","after":"les_3"}'
# → { "data": { "position": 4, "shifted": 2, "repaired": 0 } }
```

Exactly one of `before` / `after`, naming the row to land next to. Only the rows
**between** the old place and the new one are renumbered — two set-wise
statements, whatever the size of the list.

Both rows must be in the same list. Moving a row to a different list is a change
to the scope column, so it is an ordinary `PATCH`:

```bash
curl -X PATCH /api/items/lessons/les_9 -d '{"module":"mod_2"}'
```

…which **re-appends** the row to the end of the list it just joined. Keeping its
old position would land it on a number another row already holds, and a tie is
the one thing a later move cannot survive.

### Available everywhere

| Surface | |
|---|---|
| REST | `POST /api/items/{slug}/reorder` |
| SDK | `client.from("lessons").reorder("position", id, { after: otherId })` |
| GraphQL | `mutation { reorderItem(collection: "lessons", field: "position", id: …, after: …) { position } }` |
| CLI | `bun backlex items reorder lessons les_9 --field position --after les_3` |
| MCP | `order.move` |
| Admin | drag a row in the list view |

Every one of them calls the same service, so the arithmetic cannot drift between
them.

### Who may rearrange

Rearranging needs `update` on the collection — and specifically an
**unconditioned** one that covers the order column. Both restrictions exist
because an ordering operation writes rows the caller never named:

- A role whose `update` carries a **field allow-list** that excludes the order
  column (`fields: ["title"]` — "may rename menu entries, may not rearrange the
  menu") is refused, exactly as `PATCH` refuses it. Otherwise the allow-list
  would have a second door.
- A role whose `update` carries a **row condition** — every bundled self-service
  role does, e.g. `app_user_id = $user.id` — is refused too, and this one is
  worth spelling out because refusing looks stricter than necessary. It is not:
  a move shifts a span of rows, and the tie repair renumbers a whole list.
  Ignoring the condition would rewrite other people's rows; applying it would
  renumber a subset that then collides with the rows it skipped, leaving the list
  *less* ordered than it started. Neither is an answer, so the operation is
  refused (403). Rearranging a shared list is a whole-list privilege.

A caller who may only edit their own rows can still create them — appending is
per-row and needs nothing extra.

## Repairing a column that was never really ordered

Positions have to be **unique within a list** for a move to work. Gaps are fine —
a delete leaves one and nothing breaks — but ties are not: shifting `position >=
1` across a column of zeros moves nothing, and the row lands at the end instead
of where it was dropped.

Which is the state every collection that predates this feature is in.

```bash
curl -X POST /api/items/lessons/order/normalize -d '{"field":"position"}'
# → { "data": { "scopes": 12, "renumbered": 43, "fields": ["position"] } }
```

This rewrites each list to 1…N, **keeping the order the rows currently read in**:
current position first, then when the row was created. That tiebreak is the whole
answer on the lists that need repairing, since every position on them is the same
0 — falling through to the primary key would sort a curriculum by the random
UUIDs of its lessons.

It is idempotent, so re-running it changes nothing. A `reorder` also runs it
against its own list first when it finds ties, and reports the count as
`repaired` — so a legacy collection is draggable without anyone having to know
this endpoint exists.

Two honest limits:

- **Rows written inside the same millisecond** — a bulk import, a restore — share
  a `created_at` and fall through to the primary key. There is no portable
  monotonic tiebreak to reach for, and a bulk write that had an order to preserve
  states its positions anyway.
- **A single list larger than 10,000 rows is refused.** Breaking a tie means
  rewriting the whole list, so unlike the email and phone normalizers this cannot
  be paged. A list that large is not one a person arranged; narrow it with
  `order.scope`.

## In the admin

The list view offers drag-to-reorder when — and only when — the list is actually
*in* the order being dragged: the collection has an order field and the table is
sorted by it, ascending. Dragging a list sorted by `updated_at` would be a
gesture with no meaning: the row would appear to move and jump back on the next
render, which reads as a failed save.

The drop is **optimistic**. The row lands where it was dropped immediately and
the server catches up; a failure rolls the list back and raises the error.

The position column itself is read-only in the item form, the grid and bulk edit.
It is not that a write would be rejected — the API accepts a stated position —
but that typing `3` into a box puts the row on a number another row already
holds, which is the tie the feature exists to prevent. Dragging is how it
changes.

## What is deliberately not supported

- **A raw "set position" API.** `reorder` states an intent; setting a number is
  the manual renumbering this replaces. A caller that genuinely needs to state
  positions (an import, a restore) does it on create, where nothing else is
  moving.
- **A column-level `UNIQUE`.** Positions are unique *within a list*; a table-wide
  constraint would stop two modules both having a first lesson. The uniqueness
  that matters is maintained by the write path.
- **Sparse positions with midpoint inserts** (1024, 2048, 3072 …), which would
  make a move one statement instead of two. Rejected because an operator can see
  this column and every template already means 1, 2, 3.
- **`rollup` / `sequence` / `computed` / `localized` on the same field.** Each of
  the first three already owns the column's value by another rule, and a list is
  not in a different order in French.
