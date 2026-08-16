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
and [field conditions](/field-conditions/) run. It is an application-layer check
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
  vocabulary as the [filter DSL](/querying/):
  `{ "$now": { "sub": { "days": 1 } } }`. The incoming value is parsed to
  epoch-ms before comparison. (Timestamp values are written as epoch-ms — an ISO
  string is not stored correctly on SQLite.)
- **`minSelect` / `maxSelect`** bound how many ids a `relation_many` array may
  hold. `maxSelect: 1` effectively makes it single-select.
- **`message`** overrides the generated error text for **any** failure on that
  field (per-value or the cross-field `rule`).
- Empty values (`null` / `undefined` / `""`) skip per-value validation — use the
  `required` flag (or a [conditional required](/field-conditions/)) to force a
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
autocomplete offers each sibling field as `$field.<name>`.

## Related

- [Field conditions](/field-conditions/) — conditional `required` / `readonly` /
  `hidden` from other fields.
- [Hashed fields](/hashed-fields/) — write-only secrets; validation applies to
  the plaintext.
- [Permissions](/permissions/) — the filter DSL the `rule` escape hatch reuses.
