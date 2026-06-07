---
title: Querying the items API
description: One Directus-shaped URL for filter, search, sort, projection, pagination, and counts.
---

`GET /api/items/<slug>` is backlex' Directus-shaped REST query endpoint:
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
| `expand` | comma-separated relation field list | none                                  | Inline-expand each named relation: the FK id is replaced by the target row    |
| `limit`  | integer 1-200                     | `50`                                    | Page size                                                                    |
| `offset` | integer ≥ 0                       | `0`                                     | Page offset                                                                  |
| `meta`   | `filter_count`, `total_count`, `*`| none                                    | Adds extra `SELECT COUNT(*)` to the response `meta`                          |
| `locale` | string or `*`                     | `null`                                  | Projects `i18n_text` fields to one locale; `*` returns the full `{xx: …}` map |

Only the list endpoint accepts these except `?expand`, which the single
GET (`GET /:id`) also accepts. `POST`, `PATCH`, and `DELETE` use
`requirePermission` only — no query parameters.

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
| `_between`     | inclusive range `[lo, hi]`     | `{ "total": { "_between": [10, 20] } }`  |
| `_icontains` / `_istarts_with` / `_iends_with` | case-insensitive LIKE (LOWER() both sides → PG/SQLite parity) | `{ "name": { "_icontains": "alice" } }` |
| `_empty` / `_nempty` | is / is-not (null or empty string) | `{ "note": { "_empty": true } }`   |

### Logical combinators

Top-level keys are an implicit `$and`. `$and`, `$or`, and `$not` nest
freely. The underscore aliases `_and` / `_or` / `_not` are also accepted
and normalized to the `$`-forms.

```json
{
  "$or": [
    { "owner_id": { "_eq": "$user.id" } },
    { "published": { "_eq": true } }
  ]
}
```

### Accepted input shapes (normalization)

Incoming filters pass through `normalizeCondition` (`@backlex/core`) before
validation, so three conveniences map onto the one canonical form:

- **Logical aliases** — `_and` / `_or` / `_not` → `$and` / `$or` / `$not`.
- **Nested-object relation filters** — `{ "customer": { "name": { "_eq": "A" } } }`
  flattens to the dotted key `{ "customer.name": { "_eq": "A" } }` (only when
  the head is a relation field — a `json` column named like a relation is left
  alone).
- **Implicit equality** — `{ "status": "active" }` → `{ "status": { "_eq": "active" } }`.

The canonical stored/wire form is unchanged, so permission rows need no
migration.

### Variables

Resolved against the auth subject before the SQL fragment is emitted:

- `$user.id` — current user id (null when anonymous; comparisons
  short-circuit to false so anonymous callers don't match
  `{ owner_id: { _eq: "$user.id" } }`)
- `$user.email`
- `$user.roles` — role-name array
- `$tenant.id` — active workspace id
- `$now` — the current instant. Supports **relative offsets** via an object
  form usable anywhere a value is expected (filters and permission rules):
  `{ "$now": { "sub": { "months": 1 } } }` (also `add`; units: `years`,
  `months`, `weeks`, `days`, `hours`, `minutes`, `seconds`). Resolved to the
  dialect-correct physical type (SQLite epoch-ms, PG `timestamptz`). A single
  clock is captured per request so SQL and the realtime predicate agree.

```json
{ "placed_at": { "_gte": { "$now": { "sub": { "months": 1 } } } } }
```

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

**Relation projection.** `fields` accepts single-hop relation dot-paths —
the same traversal grammar filter and sort use. `fields=id,title,customer.name`
returns the related row inlined and trimmed: `{ id, title, customer: { id, name } }`.
`customer.*` inlines the whole readable related row (equivalent to
`expand=customer`). Each requested leaf is validated against the target's
schema + read permission (unknown leaf → `422`, no permission → `403`).
Multi-hop projection (`a.b.c`) and `relation_many` projection return `422`
(use `filter`/`sort` for those, or expand one hop). Under the hood this reuses
the `expand` JOIN, sharing the alias when a filter already joined the relation.

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

`filter` and `sort` accept dotted keys `<relation>.<sub>` (one hop) or
`<relation>.<relation2>.…<sub>` (multi-hop, up to **2 hops** deep (3 dotted segments: `head.middle.leaf`)).
parseQuery validates the shape; the list handler walks the chain and
emits one `LEFT JOIN target AS rel_<chain>` per hop, then routes both
`WHERE` and `ORDER BY` through the deepest alias. Joins are keyed by
the full chain prefix, so two clauses sharing a prefix (e.g.
`customer_id.address_id.city` and `customer_id.address_id.zip`) emit
one join on customers and one on addresses — not duplicates of each.

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

- **Up to 2 hops** (3 dotted segments). `a.b.c.d` returns `422`. Each
  hop's target collection is loaded and read-permission-checked at
  compile time.
- **`relation_many` filters lower to `EXISTS`, not a JOIN.** See
  ["Filtering through a `relation_many` field"](#filtering-through-a-relation_many-field)
  below. Sorting through `relation_many` is still rejected — there's no
  well-defined order across the array's members. Multi-hop chains
  cannot traverse `relation_many` at any segment (only single-hop
  `relation_many` is supported).
- **Permission-gated at every hop.** The caller must hold read on
  every target collection in the chain *and* the leaf sub-field,
  otherwise `403`. See "Permission interactions" below.
- **Self-referential FKs work.** A `parent_id` relation on the same
  collection joins as `rel_parent_id` the same way. Multi-hop self
  references (`parent_id.parent_id.title`) work too — aliases stay
  unique via the `__` separator (`rel_parent_id__parent_id`).

### Filtering through a `relation_many` field

`relation_many` stores foreign ids as a JSON array (`jsonb` on PG, text
JSON on SQLite). A nested filter on a `relation_many` head doesn't
materialize a JOIN — it lowers to an `EXISTS` subquery that unpacks the
array and joins on membership, on a per-clause basis:

```bash
curl '/api/items/posts?filter={"tags.name":{"_contains":"art"}}'
```

PG:

```sql
WHERE EXISTS (
  SELECT 1 FROM c_tags AS sub
  WHERE sub.id IN (SELECT value FROM jsonb_array_elements_text(posts.tags))
    AND sub.tenant_id = $1            -- tenant-scoped targets only
    AND sub.name LIKE '%art%'
)
```

SQLite / D1:

```sql
WHERE EXISTS (
  SELECT 1 FROM c_tags AS sub
  WHERE sub.id IN (SELECT value FROM json_each(posts.tags))
    AND sub.tenant_id = ?
    AND sub.name LIKE '%art%'
)
```

Every operator (`_eq`, `_neq`, `_in`, `_nin`, `_gt/_gte/_lt/_lte`,
`_contains/_starts_with/_ends_with`, `_null`) applies to `sub.<sub>` the
same way it would against a plain column. Multi-clause shapes — e.g.
`{"tags.name":{"_contains":"a"},"tags.id":{"_in":["…"]}}` — emit one
`EXISTS` per clause AND'd together; this is on purpose (each clause is
satisfied by *some* related row, not necessarily the same one). Nested
`relation_many` inside `$or`/`$and`/`$not` works as expected — the
lowering happens per leaf and respects the tree's boolean structure.

### Edge cases and 4xx messages

| Situation                                                       | Status | Message                                                            |
|-----------------------------------------------------------------|--------|--------------------------------------------------------------------|
| More than 2 hops (`a.b.c.d`)                                    | 422    | `Nested filter exceeds max depth: a.b.c.d`                         |
| Nested sort through a `relation_many` field                     | 422    | `Nested sort on relation_many is not supported: <field>`           |
| Multi-hop chain through a `relation_many` field                 | 422    | `Multi-hop nested filter through relation_many is not supported: "<slug>.<segment>"` |
| Head is not a relation field                                    | 422    | `Nested filter only works on relation fields — "<head>" is <type>` |
| Mid-chain segment is not a relation field on its source         | 422    | `Nested filter hop "<segment>" on "<slug>" is not a relation field` |
| Unknown sub-field on target collection                          | 422    | `Unknown field on relation target "<slug>": <sub>`                 |
| Target collection is archived (any hop)                         | 422    | `Relation target not active: <slug>`                               |
| No read permission on a target collection (any hop)             | 403    | `No read permission on relation target: <slug>`                    |
| Sub-field outside target permission `fields` allow-list         | 403    | `No permission to read "<slug>.<sub>"`                             |
| Head relation outside source `fields` allow-list                | 403    | `No permission to read field: <head>`                              |

## Worked examples

```bash
# Filter on a related field
curl '/api/items/orders?filter={"customer_id.email":{"_ends_with":"@acme.com"}}'

# Sort by a related field
curl '/api/items/orders?sort=-customer_id.created_at'

# Multi-hop filter: orders → customers → addresses
curl '/api/items/orders?filter={"customer_id.address_id.city":{"_eq":"Berlin"}}'

# Multi-hop sort: orders ordered by the customer's address city
curl '/api/items/orders?sort=-customer_id.address_id.city'

# Combined: filter + sort + projection + meta — one JOIN
curl '/api/items/orders?filter={"customer_id.name":{"_eq":"Alice"}}&sort=-amount&fields=id,amount&meta=filter_count'

# Filter through a relation_many (lowers to EXISTS, not a JOIN)
curl '/api/items/posts?filter={"tags.name":{"_eq":"art"}}'

# Free-text search narrowed by a filter
curl '/api/items/posts?q=cluster&filter={"published":{"_eq":true}}'

# Locale projection
curl '/api/items/articles?locale=tr'
```

### Multi-hop mental model

For `filter={"customer_id.address_id.city":{"_eq":"Berlin"}}` on
`orders`, the compiler emits:

```sql
SELECT orders.*
FROM c_orders AS orders
LEFT JOIN c_customers AS rel_customer_id
  ON rel_customer_id.id = orders.customer_id
 AND rel_customer_id.tenant_id = $1
LEFT JOIN c_addresses AS rel_customer_id__address_id
  ON rel_customer_id__address_id.id = rel_customer_id.address_id
 AND rel_customer_id__address_id.tenant_id = $1
WHERE rel_customer_id__address_id.city = 'Berlin'
  AND -- … permission whereSql, tenant scope, etc.
```

Aliases use `__` (double underscore) as the segment separator so a
3-hop chain stays under PG's 63-char identifier limit and never
collides with a shorter prefix's alias.

## Expanding related rows (`expand`)

`expand=<rel_field>[,<rel_field>…]` inlines the target row of each named
relation in the response: the FK id is replaced by the full related
object, so a single round-trip returns both sides of the relation.

```bash
curl '/api/items/orders?fields=id,title,customer_id&expand=customer_id'
```

Response:

```json
{
  "data": [
    {
      "id": "o-1",
      "title": "X",
      "customer_id": { "id": "c-1", "name": "Alice", "email": "alice@…" }
    }
  ]
}
```

Multiple expansions are comma-separated:

```bash
curl '/api/items/orders?expand=customer_id,owner'
```

Both the list endpoint (`GET /api/items/<slug>`) and the single-item
endpoint (`GET /api/items/<slug>/<id>`) accept `expand`.

### Mental model — what the compiler emits

```sql
SELECT base.*,
       CASE WHEN base.customer_id IS NULL THEN NULL
            ELSE jsonb_build_object(            -- json_object on SQLite
              'id', rel_customer_id.id,
              'created_at', rel_customer_id.created_at,
              'name', rel_customer_id.name,
              'email', rel_customer_id.email
            )
       END AS "__expand_customer_id"
FROM c_orders AS base
LEFT JOIN c_customers AS rel_customer_id
  ON rel_customer_id.id = base.customer_id
 AND rel_customer_id.tenant_id = $1
```

- One LEFT JOIN per expanded field. Aliases (`rel_<head>`) are
  **shared with the nested-filter chain walker** — combining
  `?filter={"customer_id.name":…}` with `?expand=customer_id` produces
  exactly one join, not two.
- The `CASE WHEN base.<head> IS NULL THEN NULL` wrapper is load-bearing:
  without it, both `jsonb_build_object` (PG) and `json_object` (SQLite)
  happily build `{id: null, name: null, …}` from a JOIN miss, which
  would silently change the wire shape for unset relations.
- The fully-built JSON object is selected as `__expand_<head>` and
  substituted under the `<head>` key during deserialization, so the
  caller never sees the synthetic column.

### Permission cascade

`expand=<head>` is a read against the target collection, gated the same
way nested filter is:

1. The source collection's `read` perm must already allow `<head>`
   (the caller's `fields` allow-list on the source).
2. The target collection's `read` perm must be allowed (`403` otherwise).
3. Target's `fields` allow-list filters the JSON object's keys — fields
   outside the allow-list are dropped from every expanded row (system
   columns `id`, `created_at`, `updated_at`, `owner_id` always stay).

So a target role that grants read on `id, name` but not `email` produces
`{id, name}` in the expanded object — same shape as `GET
/api/items/customers/<id>` would have returned for that caller.

### Tenant scope

The JOIN's `ON` clause pins `rel_<head>.tenant_id = $tenant` whenever
the target is tenant-scoped — a stale cross-tenant FK never surfaces a
related row, matching the nested-filter JOIN behavior.

### Null relations

A null source FK (`customer_id IS NULL`) returns `"customer_id": null`
in the response, NOT `{id: null, …}`. The CASE wrapper enforces this so
unset relations look the same expanded or not.

### Edge cases and 4xx messages

| Situation                                                       | Status | Message                                                            |
|-----------------------------------------------------------------|--------|--------------------------------------------------------------------|
| `expand` chain (`a.b`)                                          | 422    | `expand chain not yet supported: <field>`                          |
| `expand` on a `relation_many` field                             | 422    | `expand on relation_many not yet supported: <field>`               |
| `expand` on a non-relation field                                | 422    | `expand only works on relation fields — "<field>" is <type>`       |
| Unknown expand field                                            | 422    | `Unknown expand field: <field>`                                    |
| Source `fields` allow-list excludes the relation field          | 403    | `No permission to read field: <field>`                             |
| Target collection is archived                                   | 422    | `Relation target not active: <slug>`                               |
| Caller has no read permission on the target collection          | 403    | `No read permission on relation target: <slug>`                    |

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
target rows through differential response shape, so backlex treats
the join as a read against the target and refuses to compile it when
the caller can't read directly either.

When joins are present the source permission's `whereSql` is also
recompiled through the join-aware column resolver, so a condition like
`{ owner_id: { _eq: "$user.id" } }` is pinned to the base table and
doesn't ambiguously resolve against the joined target's `owner_id`.

## What's not yet supported

- **Beyond 2 hops** — `a.b.c.d` and deeper return `422`. The hard
  ceiling exists to keep alias lengths well under PG's 63-char
  identifier limit and to keep the JOIN ladder readable in `EXPLAIN`.
  A 3rd hop can be added by lifting the `dotCount > 2` cap in
  `parseQuery` — the JOIN builder in `items.ts` is already recursive.
- **Multi-hop through `relation_many`** — only single-hop
  `relation_many` filters lower to `EXISTS`. A multi-hop chain whose
  middle (or last) segment is a `relation_many` field returns `422` —
  joining through a JSON array of foreign ids needs a different
  lowering (LATERAL unnest on PG, sub-SELECT on SQLite) that doesn't
  compose cleanly with the LEFT-JOIN ladder. Tracked as a follow-up.
- **Sorting through `relation_many`** — there's no well-defined order
  across the array's members; filter is supported via `EXISTS`, sort
  still returns `422`.
- **`?expand=` chain (`a.b`)** — single-hop only. Chained expansion
  (`?expand=customer_id.address_id`) returns `422`. The mechanics
  (per-hop target collection load + read-permission gate + nested JOIN)
  are the same as for nested filter; the lowering just hasn't been
  wired up yet. Tracked as a follow-up.
- **`?expand=` on a `relation_many` field** — expanding an array of
  foreign ids would emit `array<object>` rather than `object`, which
  needs a different SQL strategy (PG: `LATERAL` + `jsonb_agg`; SQLite:
  correlated sub-`SELECT json_group_array(…)`). Returns `422` for now.

## SDK fluent query builder

The public SDK (`@backlex/client`) ships a chainable, type-safe builder that
**compiles to the canonical `ListQuery` JSON** above — it's an ergonomics layer,
not a new wire format, so permissions, AI plans, and serialization all stay on
the one grammar.

```ts
const { data } = await client.from<Order>("orders").query()
  .where(f => f.and(
    f.eq("status", "active"),
    f.gte("total", 100),
    f.rel("customer", c => c.eq("tier", "gold")),     // → "customer.tier"
    f.gte("placed_at", f.now({ sub: { months: 1 } })), // relative date
  ))
  .select("id", "total", "customer.name")             // relation projection
  .orderBy("-placed_at", "id")
  .limit(50)
  .list();
```

`f` exposes every operator (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`in`/`nin`/
`between`/`isNull`/`empty`/`nempty`/`contains`/`icontains`/`startsWith`/
`endsWith`), the combinators `and`/`or`/`not`, `rel(head, …)` for relation
traversal, and `now({ add | sub })` for relative dates. Field arguments are
typed `keyof T | (string & {})` — autocomplete for known columns, dotted
relation paths still allowed, no codegen. `.toQuery()` returns the plain
`ListQuery`; `from(slug).list(rawQuery)` remains for hand-built queries.
