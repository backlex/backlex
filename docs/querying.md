# Querying the items API

`GET /api/items/<slug>` is workeros' Directus-shaped REST query endpoint:
one URL covers filter, full-text search, sort, projection, pagination,
count metadata, and locale projection. Parsing lives in
`apps/web/src/server/lib/query.ts::parseQuery`; the same compile path
backs the GraphQL resolver.

## The shape

| Param    | Type                              | Default                                 | What it does                                                                 |
|----------|-----------------------------------|-----------------------------------------|------------------------------------------------------------------------------|
| `filter` | JSON-encoded DSL condition        | `null`                                  | Row predicate; AND'd with the role's permission `whereSql`                   |
| `q`      | string                            | none                                    | Free-text `_contains` across every readable text/longtext field              |
| `sort`   | comma-separated field list        | collection `default_sort`, else `-created_at` | `-` prefix = `DESC`; multi-column                                            |
| `fields` | comma-separated field list        | all readable                            | SQL-level projection; system columns always re-added                         |
| `limit`  | integer 1-200                     | `50`                                    | Page size                                                                    |
| `offset` | integer ≥ 0                       | `0`                                     | Page offset                                                                  |
| `meta`   | `filter_count`, `total_count`, `*`| none                                    | Adds extra `SELECT COUNT(*)` to the response `meta`                          |
| `locale` | string or `*`                     | `null`                                  | Projects `i18n_text` fields to one locale; `*` returns the full `{xx: …}` map |

Only the list endpoint accepts these. `GET /:id`, `POST`, `PATCH`, and
`DELETE` use `requirePermission` only — no query parameters.

## Filters

`filter=<JSON>` takes the same mini-DSL as a role's
`permission.condition`. The compiler emits Drizzle `SQL` fragments
(parameterized) and never string-concatenates user input.

### Operators

| Op             | Means                          | Example                                  |
|----------------|--------------------------------|------------------------------------------|
| `_eq`          | equal                          | `{ "status": { "_eq": "published" } }`   |
| `_neq`         | not equal                      |                                          |
| `_in`          | in array                       | `{ "status": { "_in": ["a", "b"] } }`    |
| `_nin`         | not in array                   |                                          |
| `_gt` / `_gte` / `_lt` / `_lte` | numeric / lexical | `{ "views": { "_gt": 100 } }`            |
| `_null`        | is / is-not null (boolean)     | `{ "deleted_at": { "_null": true } }`    |
| `_contains`    | LIKE `%x%`                     | `{ "title": { "_contains": "foo" } }`    |
| `_starts_with` | LIKE `x%`                      |                                          |
| `_ends_with`   | LIKE `%x`                      |                                          |

### Logical combinators

Top-level keys are an implicit `$and`. `$and`, `$or`, and `$not` nest
freely.

```json
{
  "$or": [
    { "owner_id": { "_eq": "$user.id" } },
    { "published": { "_eq": true } }
  ]
}
```

### Variables

Resolved against the auth subject before the SQL fragment is emitted:

- `$user.id` — current user id (null when anonymous; comparisons
  short-circuit to false so anonymous callers don't match
  `{ owner_id: { _eq: "$user.id" } }`)
- `$user.email`
- `$user.roles` — role-name array
- `$tenant.id` — active workspace id
- `$now` — `Date.now()`

### Free-text search (`q`)

`q=<text>` expands to `_contains` OR'd across every `text` / `longtext`
field the caller has read permission on, then is **AND**'d with `filter`.
So `q=alice&filter={"status":{"_eq":"active"}}` narrows the search; it
doesn't widen the filter. Fields outside the role's `fields` allow-list
are never searched.

## Sorting

`sort=field,-other,third` produces `ORDER BY field ASC, other DESC,
third ASC`. Empty `sort` falls back to the collection's `default_sort`,
then to `-created_at`. Sort fields are validated against both the
column set and the role's `fields` allow-list, so a sort can't leak
the existence of a hidden column.

## Projections (`fields`)

`fields=a,b,c` becomes a SQL-level `SELECT a, b, c, …`. System columns
(`id`, `created_at`, `updated_at`, plus `owner_id` for owner-scoped
collections) are always re-added. Unknown fields → `422 VALIDATION`;
fields outside the role's allow-list → `403 FORBIDDEN`. Omit `fields`
and projection collapses to the role's `fields` set (or all columns
when that set is null).

## Pagination

`limit` is clamped to `[1, 200]` (default `50`); `offset` is non-negative
(default `0`). The hard cap is server-side — `limit=1000` silently
becomes `200`.

## Metadata (`meta`)

`meta=filter_count` adds `meta.filter_count` (rows matching `filter` +
permission + tenant scope). `meta=total_count` adds `meta.total_count`
(rows matching permission + tenant scope only — the caller's full
slice). `meta=*` gives both. Each count is one extra `SELECT COUNT(*)`.

## Localized fields (`locale`)

Collections with `i18n_text` fields store each value as a `{locale: …}`
JSON map. `?locale=tr` projects every `i18n_text` field down to that
locale's string with the fallback chain: requested locale → workspace
default → first non-empty entry. `?locale=*` (or omitting the param)
returns the full map.

## Nested queries (relations)

`filter` and `sort` accept a one-level dotted key `<relation>.<sub>`.
parseQuery validates the shape; the list handler adds a
`LEFT JOIN target AS rel_<relation>` and routes both `WHERE` and
`ORDER BY` through that alias. The alias is shared, so using the same
relation in filter and sort produces one join, not two.

### Filter

```bash
curl '/api/items/orders?filter={"customer_id.name":{"_eq":"Alice"}}'
```

Mental model — what the compiler emits:

```sql
SELECT orders.*
FROM c_orders AS orders
LEFT JOIN c_customers AS rel_customer_id
  ON rel_customer_id.id = orders.customer_id
 AND rel_customer_id.tenant_id = $1
WHERE rel_customer_id.name = 'Alice'
  AND -- … permission whereSql, tenant scope, etc.
```

The cross-tenant guard on the JOIN is added whenever the target is
tenant-scoped, so a stale FK pointing across workspaces can't surface a
related row.

### Sort

```bash
curl '/api/items/orders?sort=-customer_id.created_at'
```

Same join — `ORDER BY rel_customer_id.created_at DESC`. Combine freely
with filter: `?filter={"customer_id.name":{"_eq":"Alice"}}&sort=-customer_id.created_at`
produces one join, not two.

### Limits

- **Single-level only.** `a.b.c` returns `422` — multi-hop joins are
  planned.
- **`relation` only.** Nested filtering through `relation_many`
  (JSON-array storage) returns `422`; an `EXISTS` / `json_each`
  lowering is planned.
- **Permission-gated.** The caller must hold read on the target
  collection *and* the specific sub-field, otherwise `403`. See
  "Permission interactions" below.
- **Self-referential FKs work.** A `parent_id` relation on the same
  collection joins as `rel_parent_id` the same way.

### Edge cases and 4xx messages

| Situation                                                       | Status | Message                                                            |
|-----------------------------------------------------------------|--------|--------------------------------------------------------------------|
| Multi-level dotted key (`a.b.c`)                                | 422    | `Multi-level nested filter not supported yet: a.b.c`               |
| Nested filter through a `relation_many` field                   | 422    | `Nested filter on relation_many not supported yet: <field>`        |
| Head is not a relation field                                    | 422    | `Nested filter only works on relation fields — "<head>" is <type>` |
| Unknown sub-field on target collection                          | 422    | `Unknown field on relation target "<slug>": <sub>`                 |
| Target collection is archived                                   | 422    | `Relation target not active: <slug>`                               |
| No read permission on the target collection                     | 403    | `No read permission on relation target: <slug>`                    |
| Sub-field outside target permission `fields` allow-list         | 403    | `No permission to read "<slug>.<sub>"`                             |
| Head relation outside source `fields` allow-list                | 403    | `No permission to read field: <head>`                              |

## Worked examples

```bash
# Filter on a related field
curl '/api/items/orders?filter={"customer_id.email":{"_ends_with":"@acme.com"}}'

# Sort by a related field
curl '/api/items/orders?sort=-customer_id.created_at'

# Combined: filter + sort + projection + meta — one JOIN
curl '/api/items/orders?filter={"customer_id.name":{"_eq":"Alice"}}&sort=-amount&fields=id,amount&meta=filter_count'

# Free-text search narrowed by a filter
curl '/api/items/posts?q=cluster&filter={"published":{"_eq":true}}'

# Locale projection
curl '/api/items/articles?locale=tr'

# 422 — nested filter on relation_many is not supported yet
curl '/api/items/articles?filter={"tags.name":{"_eq":"x"}}'
# {"error":{"code":"VALIDATION","message":"Nested filter on relation_many not supported yet: tags"}}
```

## Permission interactions

Nested filter and sort aren't just data-shape syntax — they're a
permission gate. Using `customer_id.email` in a filter requires that
the caller:

1. holds read on the **source** collection (the usual
   `requirePermission("read")` middleware),
2. holds read on the **target** collection (resolved at compile time
   when the JOIN is materialized), and
3. has `email` inside the role's `fields` allow-list on the target.

This is deliberately invasive: a nested filter leaks the presence of
target rows through differential response shape, so workeros treats
the join as a read against the target and refuses to compile it when
the caller can't read directly either.

When joins are present the source permission's `whereSql` is also
recompiled through the join-aware column resolver, so a condition like
`{ owner_id: { _eq: "$user.id" } }` is pinned to the base table and
doesn't ambiguously resolve against the joined target's `owner_id`.

## What's not yet supported

- **Multi-level nested** (`a.b.c`) — needs a recursive resolver across
  multiple join aliases.
- **`relation_many` nested** — will lower to `EXISTS` on PG and
  `json_each` on SQLite; storage is array-of-id, not a joinable scalar.
- **`?expand=customer_id`** — REST returns bare relation ids. To inline
  related rows, use GraphQL (type-aware expansion via the schema
  registry). A REST `expand` parameter is on the table but not shipped.
