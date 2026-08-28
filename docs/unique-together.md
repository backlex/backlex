---
title: Unique together
description: One row per pair — the join-table rule a per-column `unique` cannot express.
---

`unique` is per column. A join table's identity is a **pair**: one inventory
level per (variant, location), one listing per (product, channel), one selected
value per (variant, option). Neither column is unique on its own — a variant has
many levels, a location stocks many variants — so a per-column `unique` cannot
say what the table means, and without it nothing stops a second row for the same
pair.

That is not a tidiness problem. Three inventory levels for one (variant,
location) made `sum(available)` answer `146` for a number that should be one;
a variant held `Size = S` **and** `Size = M` at once, which is exactly the
unresolvability its link table exists to prevent; and a product carried two
channel listings, one saying published and one saying not, with nothing to
decide which the storefront reads.

## Declaring it

`uniqueWith` goes on **one** of the participating fields and names the others:

```jsonc
POST /api/collections
{
  "slug": "inventory_levels",
  "fields": [
    { "name": "variant",  "type": "relation", "to": "product_variants", "required": true },
    { "name": "location", "type": "relation", "to": "locations", "required": true,
      "uniqueWith": ["variant"] },
    { "name": "on_hand",  "type": "integer", "default": 0 }
  ]
}
```

A second row for a pair that already exists comes back `409`:

```json
{ "error": { "code": "CONFLICT", "message": "A row with these values already exists (unique constraint)." } }
```

More than two columns is the same shape — list them all:

```jsonc
{ "name": "relation_type", "type": "text", "uniqueWith": ["product", "related_product"] }
```

That is the commerce model's `related_products`: the same two products may be
both an *accessory* and a *replacement*, but not two accessories.

## What it compiles to

`applyCollection` emits one `CREATE UNIQUE INDEX IF NOT EXISTS` per declared
set, over `(tenant_id, …columns)` when the collection is tenant-scoped —
leading with the tenant exactly as the keyset index does, so one workspace's
pair can never block another's. Idempotent, so it is picked up on a later
`PATCH` as well as on create, and it is skipped for adopted tables like every
other DDL.

The set is **sorted and deduplicated**, so declaring the same rule from both
ends is one index rather than two that differ only in column order:

```jsonc
{ "name": "variant",  "uniqueWith": ["location"] }   // ← these two are
{ "name": "location", "uniqueWith": ["variant"] }    //   the same constraint
```

A collection may hold several distinct sets by declaring each on a different
field.

## Rules

- The named siblings must exist, and a field cannot name itself.
- Refused beside `unique` on the same field — a column unique on its own is
  unique in any pair, and two rules would disagree about which one refused a
  write.
- Every participant needs a scalar column of its own, so `relation_many`,
  `localized`, `hash` and `rollup` fields are refused with the reason.
- **Make the participants `required`.** `NULL` compares distinct in both
  dialects, so two rows that both leave a column empty slip past the index. If
  the pair is what the row IS, neither half is optional.

## Adding it to a table that already breaks it

Refused, and the refusal counts the offending groups:

```json
{ "error": { "code": "CONFLICT",
  "message": "Cannot make (left_side, right_side) unique on \"c_…_pairs\" — 3 values of (left_side, right_side) already appear on more than one row; remove the duplicates first" } }
```

Creating the index best-effort and logging the failure would be worse than not
having it: the schema would then claim a guarantee the data does not keep. Find
the duplicates with an aggregate, merge or delete them, and re-apply:

```
POST /api/items/<slug>/aggregate
{ "agg": "count", "groupBy": "location" }
```

## A ledger is not a set

Two required relations is a *shape*, not a rule. Whether the pair may repeat is
a question about what the second row **means**, and no property of the schema
answers it:

- `inventory_levels` — a second row for the same (variant, location) means
  nothing. It is a duplicate, and `sum(available)` starts lying. → `uniqueWith`.
- `stock_movements` — a second row for the same (variant, location) is the
  *point*. Every receipt, sale and count is its own row, and a transfer is
  deliberately two of them. → no constraint, ever.

So the question to ask a join-shaped collection is not "are these two columns
unique?" but "if I saw this pair twice, would I have learned something, or
would I reach for a reconciliation script?"

The bundled templates are held to that: every collection with exactly two
required relations either declares `uniqueWith` or is named in
`apps/web/tests/template-join-tables.test.ts` as a deliberate exception **with
the reason written out**. A new one that does neither fails the suite.

## When the database is the one that refuses

`uniqueWith` compiles to a real unique index, so the refusal can also come from
the driver rather than from a pre-check — on a race, or on an endpoint that
never pre-checks at all. Either way the caller sees the same thing:

```json
// 409
{ "error": {
  "code": "CONFLICT",
  "message": "Already exists: another row has this location + variant"
} }
```

The **columns** are named so the caller knows which field collided. The
**values** never are: a unique index can span a shared table, and the row you
collided with may not be yours to read.

## Related

- [Querying](/docs/querying/) — `indexed` and the plain B-tree index.
- [Rollups](/docs/rollups/) — the other half of a join table's correctness: a
  parent total that follows its children.
