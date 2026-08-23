---
title: Field conditions
---

**Per-field conditions**: attach rules to a field so that, when a rule matches
the row, the field becomes **required**, **readonly**, or **hidden**. The
**`required`** effect is enforced server-side on every write surface (REST,
GraphQL, SDK, MCP) — not just in the admin UI — while `readonly` / `hidden` are
live item-form effects.

Conditions live in the collection schema (the `collections.fields` JSON), so
there is **no migration** and no permission/role wiring — they apply to every
writer, admins included.

## Shape

Each field may carry a `conditions` array. A condition is a `rule` (the same
filter DSL as [permissions](/docs/permissions/) — `_eq`, `_in`, `_gt`, `_contains`,
`$and`/`$or`/`$not`, `$user.id`, …) plus the effects it toggles:

```json
{
  "name": "tracking_number",
  "type": "text",
  "conditions": [
    {
      "name": "shipped needs tracking",
      "rule": { "status": { "_eq": "shipped" } },
      "required": true,
      "readonly": false,
      "hidden": false
    }
  ]
}
```

- **`rule`** — a filter over the whole row. Empty object = always matches. Its
  field references are validated at collection create/patch (an unknown field
  is rejected 422). Multiple conditions on one field OR their effects.
- **`required`** — **server-enforced**. When the rule matches the (merged) row
  and the value is empty, create/update is rejected `422`. On update the rule is
  evaluated against the *post-patch* row, so a rule referencing a field the
  PATCH omits still holds. Static `required: true` and conditional `required`
  compose.
- **`readonly`** — item-form only: the input is disabled while the rule matches.
- **`hidden`** — item-form only: the field is removed from the editor while the
  rule matches (supersedes the older `visibleWhen`).

## Authoring

Admin → a collection → **Schema** → edit a field → **Conditions**. Each row has a
name, a visual rule builder (the same one the permission editor uses), and
Required / Readonly / Hidden toggles. The item editor re-evaluates the effects
live as you type.

## Enforcement path

`required` runs in the shared item-write service
(`services/items/validate.ts::enforceFieldConditions`, called from
`performCreate` / `performUpdate`), so it covers single writes, batch, GraphQL
mutations, and MCP alike. `$user.*` in a rule resolves from the request's auth
subject. The client evaluator (`item-form.tsx::fieldEffects`) mirrors the same
operators for the live `readonly` / `hidden` effects.
