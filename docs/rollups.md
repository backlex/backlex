---
title: Rollup fields
---

A **rollup** is a number on one row that is an aggregate over rows in another
collection: an invoice's `subtotal` over its line items, a campaign's
`raised_amount` over its donations, a budget's `amount_spent` over its expenses,
a ticket type's `sold` over the tickets issued.

backlex keeps it up to date. Every write to a row being summarised — create,
update, delete, from any surface — restates the column it feeds. The column is
read-only through the API: you change the rows, not the total.

## Why this isn't a computed field

A field's `computed` option makes it a SQL generated column
(`GENERATED ALWAYS AS (quantity * unit_price) STORED`). Those can only read the
row they sit on — neither Postgres nor SQLite lets a generated expression reach
another table. That covers `line_total = quantity × unit_price` on the line and
`balance_due = total − amount_paid` on the invoice, but not `total` itself.

A rollup is a **plain stored column** the server refreshes. Stored, rather than
computed on read, for a concrete reason: schemas routinely put a generated
column *on top of* one of these numbers (`balance_due = total - amount_paid`),
and a generated column can only reference a real column.

## Shape

```json
{
  "name": "subtotal",
  "type": "number",
  "rollup": {
    "from": "invoice_lines",
    "via": "invoice",
    "fn": "sum",
    "field": "line_total"
  }
}
```

- **`from`** — slug of the collection holding the rows being aggregated.
- **`via`** — the `relation` field **on that collection** that points back here.
  Must be a `relation`, not a `relation_many` (a list is not one parent).
- **`fn`** — `sum` · `count` · `avg` · `min` · `max`.
- **`field`** — the numeric column to aggregate. Required for everything except
  `count`, which counts rows and takes no field.
- **`filter`** — optional; see below.

The column's `type` must be `integer` or `number`. `avg` requires `number` — an
integer column would silently truncate the average.

### Empty parents

`count` and `sum` over no rows are **0** — a total of nothing is zero, not
unknown — and that is the column's DDL default, so a parent created before its
first child already reads correctly with no refresh having run. `avg` / `min` /
`max` over no rows are genuinely undefined and stay `NULL`.

### Filtering which rows count

```json
"rollup": {
  "from": "invoice_lines",
  "via": "invoice",
  "fn": "sum",
  "field": "line_total",
  "filter": { "status": { "_eq": "billable" } }
}
```

Same condition DSL as [permissions](/permissions/); field references resolve
against the **child** row.

Two rules:

- **Soft-deleted children never count**, filter or not. Deleting a line takes
  its money off the invoice whether the delete was hard or soft.
- **The filter cannot reference `$user`, `$tenant`, `$org` or `$now`** (rejected
  at save time). A rollup is one stored number every reader shares, so it must
  not depend on who triggered the refresh — otherwise the last writer's view
  becomes everyone's, and the next writer silently overwrites it with theirs.

## Reading and writing

Reads are ordinary: the column appears in REST, GraphQL, CSV export, the
changefeed and the SDK like any other number, and can be filtered and sorted on.

Writes are refused, on every surface:

```
PATCH /api/items/invoices/:id  { "subtotal": 999 }
→ 422  Field "subtotal" is a rollup of "invoice_lines" (read-only)
       — change the invoice_lines rows instead
```

The admin item form renders a rollup read-only and never sends it; bulk edit and
the spreadsheet grid skip it for the same reason.

## Keeping it honest

The refresh is a single `UPDATE … SET col = (SELECT … )` statement emitted right
after the child write, through the same chokepoint as the write itself. That
matters twice over:

- **Concurrency.** Nothing reads the old total first, so two lines inserted at
  once can't both write back the same stale number. Whichever statement runs
  second sees the first one's row.
- **Atomic batches.** The refresh joins the transaction and rolls back with the
  row that provoked it. A total that survived a rolled-back line would be wrong
  with nothing left to explain it.

Re-parenting refreshes **both** sides — moving a line from invoice A to invoice
B takes the money off A as well as putting it on B.

### Adding a rollup to a collection that already has rows

`PATCH /api/collections/:slug` backfills automatically when a rollup definition
changes, and reports what it restated:

```json
{ "ok": true, "slug": "invoices", "rollupBackfill": ["subtotal", "line_count"] }
```

Without that, existing parents would read the column's neutral default — a total
that is confidently wrong, which is worse than one that is obviously missing.

### Repairing drift

A few paths write rows without going through the item write path: a restore, a
template seed, a direct SQL edit. And a rollup added in one isolate can take up
to the schema-cache TTL (30s) to be seen by a sibling. For those:

```bash
POST /api/items/invoices/rollups/refresh   # → { ok: true, refreshed: ["subtotal"] }

bun backlex collections refresh-rollups invoices
```

Also on the SDK (`client.from("invoices").refreshRollups()`) and MCP
(`schema.rollups_refresh`). Idempotent and safe to run at any time — it restates
every rollup column on the collection from the rows it aggregates.

## Limits

- **No chaining.** A rollup cannot aggregate a column that is itself a rollup —
  the refresh statements are emitted in write order with nothing to make an
  outer total catch up, so it would sit one write behind. Refused at save time.
- **Integer-keyed collections are not supported.** The child's relation column
  stores ids as text; against an integer primary key that comparison errors on
  Postgres and — worse — matches nothing on SQLite, where every total would
  quietly read 0. (External-DB migration is what creates those collections.)
- **One hop.** A rollup reads the collection it names, not that collection's
  relations. For a grand total across two levels, roll up each level.
- **The reverse index is cached per isolate** (30s, shared with the schema
  cache). A rollup added elsewhere may not fire for that long; the refresh
  endpoint above is the recovery.

## Where it lives

| Piece | File |
|---|---|
| Field shape + validation | `packages/db/src/field-types.ts` (`RollupSpec`, `validateRollupSpec`) |
| The refresh statement | `packages/db/src/rollup.ts` |
| Runtime + reverse index + backfill | `apps/web/src/server/services/items/rollup.ts` |
| Write-path hooks | `apps/web/src/server/services/items/write.ts`, `services/graphql/core.ts` |
| Admin editor | `apps/web/src/client/admin/field-rollup-editor.tsx` |
| Tests | `apps/web/tests/rollup-field.test.ts`, `rollup-surfaces.test.ts` |
