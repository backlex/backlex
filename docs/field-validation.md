---
title: Field validation
---

**Per-field validation rules**: declare constraints on a field so writes that
violate them are rejected `422` on **every** write surface (REST, GraphQL, SDK,
MCP, batch/bulk) — not just in the admin form. Rules live in the collection
schema (the `collections.fields` JSON), so there is **no migration** and no
permission/role wiring; they apply to every writer, admins included.

Validation is enforced in the shared item-write path (`validateValue` +
`enforceValidationRules`), the same place the older `required` / `unique` flags
and [field conditions](/docs/field-conditions/) run. It is an application-layer check
— it does not add a DB `CHECK` constraint, so it fires through the API, not on
raw DB writes.

## Shape

Each field may carry a `validation` object. Every key is optional; only the ones
that make sense for the field's `type` are honoured (a mismatched key is rejected
at collection create/patch).

```json
{
  "name": "email",
  "type": "text",
  "validation": {
    "format": "email",
    "maxLength": 254,
    "message": "Please enter a valid email address"
  }
}
```

### Constraints by type

| Field type | Keys |
|---|---|
| `text` / `longtext` / `hash` | `minLength`, `maxLength`, `format` (`"email"` \| `"url"`), `regex` |
| `integer` / `number` | `min`, `max`, `integer` (whole-number, `number` only) |
| `timestamp` | `minDate`, `maxDate` |
| `relation_many` | `minSelect`, `maxSelect` (array length) |
| any type | `message`, `rule` (cross-field) |

Notes:

- **`format`** applies a canonical built-in pattern so you don't hand-write it.
  Combined with `regex`, both must pass. (`hash` validates the *plaintext* the
  caller typed, before it's hashed — so you can enforce a password policy.)
- **`minDate` / `maxDate`** accept an epoch-ms number, an ISO-8601 string, the
  literal `"$now"`, or a relative-now object using the same dynamic-date
  vocabulary as the [filter DSL](/docs/querying/):
  `{ "$now": { "sub": { "days": 1 } } }`. The incoming value is parsed to
  epoch-ms before comparison. (Timestamp values are written as epoch-ms — an ISO
  string is not stored correctly on SQLite.)
- **`minSelect` / `maxSelect`** bound how many ids a `relation_many` array may
  hold. `maxSelect: 1` effectively makes it single-select.
- **`message`** overrides the generated error text for **any** failure on that
  field (per-value or the cross-field `rule`).
- Empty values (`null` / `undefined` / `""`) skip per-value validation — use the
  `required` flag (or a [conditional required](/docs/field-conditions/)) to force a
  value.

## Cross-field rules (`rule`)

`validation.rule` is an escape hatch for constraints that depend on **other
fields** in the same row. It is a filter over the whole row (same DSL as
permissions and conditions) that **must match** for the write to succeed.
Reference a sibling field's value with `"$field.<name>"`:

```json
{
  "name": "end_date",
  "type": "timestamp",
  "validation": {
    "rule": { "end_date": { "_gte": "$field.start_date" } },
    "message": "End date must be on or after start date"
  }
}
```

- Evaluated in JS on every create/update against the fully-resolved row (on
  update, the merged before + patch row — so a rule referencing a field the
  PATCH omits is still judged against the stored value).
- `$user.id` / `$user.email` / `$user.roles` / `$now` resolve as they do in
  permission rules; `$field.<name>` is unique to validation rules.
- Field references (both the compared field and any `$field.*`) are checked at
  collection create/patch — an unknown field is rejected `422`.
- Ordered comparisons (`_gt`, `_gte`, `_lt`, `_lte`, `_between`) sort dates by
  instant, so `_gte` works on timestamp fields.
- **An ordering with a missing operand is skipped, not failed.** A draft that
  has neither date yet has not put them in the wrong order, so the rule above
  says nothing about it; the same goes for a row with only one of the two, and
  for clearing a date (the admin form sends `""`, which is absent — not the
  epoch). Use `required` for "this must be filled in"; a cross-field rule is
  for "these must agree".
- The skip is **per operator, not per rule**, so a rule keeps whatever it can
  still answer: with `{ "amount": { "_gte": "$field.floor", "_lte": 100 } }`
  and no floor set, the ceiling is still enforced. Inside `$or` or `$not` an
  unanswerable part makes the whole expression unanswerable, because a branch
  that could not be judged might have been the one that satisfied it.
- Equality is not affected: `_eq` against an absent column is `false`, and that
  is a real verdict rather than a missing one.

### Looking one relation out

A `$field.` reference may travel **one relation hop** to read a column on the
row it points at. That is what makes a cross-*row* invariant expressible — the
constraint a warehouse actually needs is not about two columns of a bin, it is
about a bin and its zone:

```json
{
  "name": "warehouse",
  "type": "relation",
  "to": "warehouses",
  "validation": {
    "rule": { "warehouse": { "_eq": "$field.zone.warehouse" } },
    "message": "A bin's zone must belong to the bin's own warehouse"
  }
}
```

`zone` is a `relation` field on this collection; `warehouse` is a column on the
collection it points at. On every write the server fetches that one row and
compares — one `SELECT` per relation a rule travels through, and none at all for
a collection whose rules stay row-local.

- **An unset relation is a question, not a violation.** A bin with no zone yet
  has no row on the other side, so the rule above says nothing about it — the
  same reasoning as a missing operand, extended to every operator (`_eq`
  included) because a hop that cannot be resolved is not a disagreement.
- **Judged against the row the relation points at *now*.** A PATCH that moves
  the bin to a zone in another warehouse is refused; one that moves both at once
  is allowed.
- Money hops compare in **major units**, so a `100.00` ceiling on the other row
  is `100.00` here and not the `10000` minor units the column holds. The
  currency code itself is not part of the comparison — the same as comparing
  two money columns of one row — so hop across currencies only when you know
  both sides are denominated the same way.

The limits are enforced when the **schema** is saved, not when a row is written,
so a mistake shows up where it was made:

| Not allowed | Why | Instead |
|---|---|---|
| `$field.a.b.c` | Two hops is two fetches | Carry the value onto `a` — a [rollup](/docs/rollups/), or a column copied on write |
| A hop through a non-relation field | Nothing on the other side to read | Compare the column itself |
| A hop through `relation_many` | Many rows; a comparison needs one | A [rollup](/docs/rollups/) over those rows |
| `{ "zone.warehouse": { "_eq": … } }` | That spelling is the query language's relation filter, which a row check cannot answer | Put the hop on the value side: `{ "warehouse": { "_eq": "$field.zone.warehouse" } }` |
| A sub-field the target does not have — including a `localized` one | The value is not in the column the hop reads | Hop to a real, non-localized column |

What a hop is *not* is an aggregate. "The sum of open reservations may not exceed
this level's quantity" reads many rows and races other writers, so it is not a
rule the write path can settle on its own; a
[rollup](/docs/rollups/) plus a same-row rule covers the cases where the total is
already maintained for you.

Note this differs from the same DSL used as a **permission** filter, on
purpose. There, a row with no amount must not match `amount >= 100` — a filter
that fell open on absence would be a hole. A validation rule asks the opposite
question ("is this row invalid?"), and refusing a row for a comparison that
never happened reports something that did not.

## Admin UI

The **Add field** and **Edit field** dialogs render a **Validation** panel with
the type-appropriate inputs (length / bounds / format / date bounds /
cardinality), a **Custom error message** box, and an **Advanced — cross-field
rule** section that builds the `rule` visually. In the rule builder, the value
autocomplete offers each sibling field as `$field.<name>`, and — for every
`relation` on the collection — each column a hop may read, as
`$field.<relation>.<column>`. The suggestions are filtered the same way the save
is: no `relation_many`, no layout block, no localized column, so anything the
list offers is something the server will accept. The field picker on the LEFT
stays row-local, because a dotted key there is refused.

## Related

- [Field conditions](/docs/field-conditions/) — conditional `required` / `readonly` /
  `hidden` from other fields.
- [Hashed fields](/docs/hashed-fields/) — write-only secrets; validation applies to
  the plaintext.
- [Permissions](/docs/permissions/) — the filter DSL the `rule` escape hatch reuses.
