---
title: Row retirement
description: Declare the boolean that says whether a row is still in play, and stop offering discontinued rows for new work without hiding them from anything that already points at them.
---

Every workspace ends up with rows that are real, referenced, and finished: a
discontinued product, a former supplier, a price list nobody sells from any
more, a closed location. **Retirement** is the declaration that one boolean
column answers that question — and once you make it, the rest of the product
starts reading it.

```json
{
  "name": "active",
  "type": "boolean",
  "default": true,
  "retire": {}
}
```

That is the whole configuration for the common case. The column stays an
ordinary writable boolean; nothing about the storage changes and there is no
migration.

## The one rule

> **Retirement never hides a row from a read.**

A retired row is still returned by `GET /api/items/{slug}` and by
`GET /api/items/{slug}/{id}`. Every relation that already points at it still
resolves. Reports, exports, invoices and order lines that reference it keep
working, for everybody, forever.

What changes is that the row stops being **offered for new work**:

| | Before the declaration | After |
|---|---|---|
| Relation picker in the admin | offers it like any other row | skips it (with an "also show rows that are out of play" toggle) |
| Admin item list | mixed in | opens on the rows still in play, with an In play / Out of play / Both control |
| `?retired=exclude` | not available | narrows to rows still in play |
| A **new** relation pointing at it | written silently | refused with `422` |
| The column | unindexed — every "only the live ones" query is a scan | indexed |

This is deliberately not the same thing as the `archived` state a `versioned`
collection's `_status` carries. That one is a *publication* lifecycle and works
by hiding rows from readers who cannot publish — right for an unfinished
article, wrong for a discontinued product an invoice must still name. Two
different questions, two different mechanisms.

## Which value means retired

`active`, `visible`, `published`, `available` — a flag phrased so that `true`
means in play — needs nothing:

```json
{ "name": "active", "type": "boolean", "default": true, "retire": {} }
```

A flag phrased the other way round says so:

```json
{
  "name": "discontinued",
  "type": "boolean",
  "default": false,
  "retire": { "retiredWhen": true }
}
```

**A NULL flag counts as in play.** A column added to a table that already had
rows backfills NULL, an adopted table brings whatever it brought, and a CSV
import writes what the file held. Reading those as retired would empty every
picker in the workspace the moment you declared the flag.

**A collection has at most one retirement flag.** Declaring `retire` on both
`active` and `visible` is refused at schema-save time: two flags means "is this
row in play" has two answers, and every consumer would have to invent its own.

## References to a retired row

By default, a write that points a **new** `relation` / `relation_many` value at
a retired row is refused:

```
422  "product" points at a retired row in "products": 8f3a… — restore the row,
     or pick one that is still in play
```

Only values the write actually names are judged. A `PATCH` that does not mention
the relation leaves it alone, and no stored reference is ever re-validated — so
retiring a product does not invalidate a single past order. That is what makes
the refusal safe to have on by default.

Turn it off per target when "still in play" is not the same question as "may be
referenced" — a historical correction legitimately points at a retired price
list:

```json
{
  "name": "active",
  "type": "boolean",
  "retire": { "references": "allow" }
}
```

There is no per-request escape hatch. If you are loading historical data whose
references are genuinely to retired rows, either declare `references: "allow"`
on the target's flag or restore the rows for the duration of the import.

## Reading

```
GET /api/items/products                     # everything (the default)
GET /api/items/products?retired=exclude     # only the rows still in play
GET /api/items/products?retired=only        # only the retired ones
```

`all` is the default everywhere and the default is the contract: a client that
has never heard of the flag gets exactly what it always got. An unrecognised
value is a `422` rather than a silent `all` — a filter that did not run should
not look like one that did.

On a collection with no `retire` field, `exclude` is every row and `only` is no
rows.

## Retiring and restoring

```
POST /api/items/{slug}/{id}/retire              # take it out of play
POST /api/items/{slug}/{id}/retire?restore=1    # put it back
```

Both go through the ordinary update path, so revisions, the activity log, the
realtime event and any flow triggers all fire exactly as they would for a
`PATCH` of the column.

**Permissions.** Requires `update` on the collection *covering the flag column*:
a role whose `update` names a field list that excludes `active` is refused a
`PATCH` of it and is refused this verb too. A **row condition** is applied
rather than refused — retiring one row does not touch any other, so retiring
what the caller can reach is a complete answer. (This is the opposite call from
`POST /{slug}/reorder`, which refuses a partial grant, because renumbering a
filtered subset collides with the rows it skipped.)

To retire many rows at once, use the ordinary bulk update
(`POST /api/items/{slug}/bulk-update`) — it writes the same column through the
same guards.

## The other surfaces

```ts
// SDK
await client.from("products").retire(id);
await client.from("products").retire(id, { restore: true });
await client.from("products").list({ retired: "exclude" });
```

```graphql
query { products(retired: "exclude") { id name } }
mutation { retireItem(collection: "products", id: "8f3a…") { field retired } }
```

```
backlex items retire products 8f3a… [--restore]
backlex items list products --retired exclude
```

MCP exposes `items.retire`.

## What retirement is not for

**A lifecycle value is not a retirement flag.** A `status` dropdown whose
choices include `cancelled` or `completed` is served by
[status transitions](/docs/status-transitions/), which knows what a status may
move to, who may move it, and what the row must carry first. Giving the same
question two owners is worse than either answer alone.

**A configuration toggle is not a retirement flag either.** A feature-flag row
whose `enabled` is `false` is very much still in play — the flag is the
feature's state, not the row's. The schema-template catalog declares `retire` on
63 of its 64 boolean flags and deliberately leaves that one out.

## Adopted tables

An adopted table gets no DDL, so the index the declaration implies is not
created — everything else works unchanged. Create the index yourself if the
column is one you filter by often.
