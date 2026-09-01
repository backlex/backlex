---
title: Querying the items API
description: One Directus-shaped URL for filter, search, sort, projection, pagination, and counts.
---

`GET /api/items/<slug>` is Backlex' Directus-shaped REST query endpoint:
one URL covers filter, full-text search, sort, projection, pagination,
count metadata, and locale projection. Parsing lives in
`apps/web/src/server/lib/query.ts::parseQuery`; the same compile path
backs the GraphQL resolver.

## The shape

| Param    | Type                              | Default                                 | What it does                                                                 |
|----------|-----------------------------------|-----------------------------------------|------------------------------------------------------------------------------|
| `filter` | JSON-encoded DSL condition        | `null`                                  | Row predicate; AND'd with the role's permission `whereSql`                   |
| `q`      | string                            | none                                    | Free-text search: `_contains` across every readable text/longtext field — or, on a [full-text-search](/docs/full-text-search) collection, a token-precise keyword-index filter |
| `sort`   | comma-separated field list        | collection `default_sort`, else `-created_at` | `-` prefix = `DESC`; multi-column                                            |
| `fields` | comma-separated field list        | all readable                            | SQL-level projection; system columns always re-added                         |
| `expand` | comma-separated relation field list | none                                  | Inline-expand each named relation: a `relation` FK → the target row, a `relation_many` array → an array of target rows |
| `limit`  | integer 1-200                     | `50`                                    | Page size                                                                    |
| `offset` | integer ≥ 0                       | `0`                                     | Page offset                                                                  |
| `meta`   | `filter_count`, `total_count`, `*`| none                                    | Adds extra `SELECT COUNT(*)` to the response `meta`                          |
| `locale` | string or `*`                     | `null`                                  | Projects `localized` fields to one locale; `*` returns the full `{xx: …}` map |

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
| `_icontains` / `_istarts_with` / `_iends_with` | case-insensitive LIKE — see [how far the fold reaches](#case-insensitive-matching-and-what-it-folds) | `{ "name": { "_icontains": "alice" } }` |
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
- `$org.id` / `$org.role` / `$user.orgs` — app-plane organization context
  (null/empty for control-plane identities). See
  [Organizations](/docs/app-organizations/).
- `$now` — the current instant. Supports **relative offsets** via an object
  form usable anywhere a value is expected (filters and permission rules):
  `{ "$now": { "sub": { "months": 1 } } }` (also `add`; units: `years`,
  `months`, `weeks`, `days`, `hours`, `minutes`, `seconds`). Resolved to the
  dialect-correct physical type (SQLite epoch-ms, PG `timestamptz`). A single
  clock is captured per request so SQL and the realtime predicate agree.

```json
{ "placed_at": { "_gte": { "$now": { "sub": { "months": 1 } } } } }
```

### Case-insensitive matching, and what it folds

`_icontains` / `_istarts_with` / `_iends_with` are **fully case- and
accent-insensitive, in every language, on both dialects**. Against a row named
`İşlemci soğutucu`, all of these find it:

```
İşlemci   işlemci   ISLEMCI   islemci   İŞLEMCİ
SOĞUTUCU  soğutucu  sogutucu  SOGUTUCU
şlem      slem      emci so                    ← mid-word, too
```

And across languages: `ozturk` finds `Öztürk`, `strasse` finds `Straße`,
`yildirim` finds `Yıldırım`, `koge` finds `Køge`, `nguyen` finds `Nguyễn`,
`athina` finds `Αθήνα`.

#### How, and why it is not just `LOWER()`

SQLite's `LOWER()` folds `A-Z` and nothing else — by documented design, because
full Unicode case conversion "would nearly double the size of the SQLite
library" — and D1 ships neither the ICU extension nor a way to register a
function. So the fold cannot happen at query time.

It happens at **write** time instead. Every `text` column carries a companion
`<name>__fold` holding a canonical form of its value: NFKD-decomposed, combining
marks removed, lowercased, with a short table for the letters that do not
decompose (`ß→ss`, `æ→ae`, `ø→o`, `ł→l`, `þ→th`, Turkish dotless `ı→i`). The
needle goes through the very same function, so the comparison is a plain `LIKE`
between two already-folded strings.

Three properties follow, and they are the reason for the shape:

- **The dialects behave identically.** Neither database folds anything, so
  Postgres and SQLite cannot disagree.
- **The SQL path and the in-memory path are one implementation.** Realtime and
  the permission simulator call the same function, so a filter never means one
  thing over REST and another over a socket.
- **It reaches further than ICU would.** ICU folds case but not diacritics, so
  even an ICU-compiled SQLite would not find `Öztürk` from `ozturk`.

The companion columns are internal: they never appear in a response, in the
schema surface, or in CSV export, and a field may not be named `*__fold`.

#### Where the fold does not reach

| | Folded | Falls back to `LOWER()` |
|---|---|---|
| `text` columns | ✅ | |
| `json` columns | ✅ its **values** — see below | |
| `longtext` (descriptions, bodies) | | ⚠️ use [full-text search](/docs/full-text-search/) |
| Adopted tables | | ⚠️ backlex never DDLs a table it did not create |

A `json` column folds the **string and number leaves** of its value, not the
serialized document — so an attribute bag matches on what a thing *is*, not on
what its fields are *called*:

```json
{ "cpu": "AMD Ryzen 9 9950X3D", "cooler": "İşlemci soğutucu", "ram": "32GB" }
```

```
_icontains "ryzen" · "9950" · "32gb"      ✓
_icontains "islemci" · "İşlemci"          ✓   ← the values, in any spelling
_icontains "cpu" · "cooler"               ✗   ← keys are not in the haystack
```

This is also the one column type where the fallback was not merely narrow but
**broken on Postgres**: `jsonb` has no `lower()`. The companion is `text` on
both dialects, so the same filter now compiles and answers identically on each.

The fallback is the old behaviour — correct for ASCII, and requiring a
non-ASCII letter to be typed in the case it is stored in. It is narrower, never
wrong.

:::note
**Upgrading an existing workspace.** A collection gains its companion columns
the next time its schema is applied — and nothing applies a schema on its own,
so a workspace that upgrades keeps the old behaviour until you ask for it:

```
POST /api/admin/db/schema/reapply
```

That re-applies every managed collection (additive and idempotent — it never
drops or rewrites a column) and backfills the rows in the same pass. Adopted
collections are skipped, because backlex never DDLs a table it did not create.
It answers with `applied` / `skipped` / `failed` per collection rather than a
single count, so one unapplyable table does not read as a failed upgrade.

The backfill itself is resumable and idempotent: it only touches a NULL
companion beside a non-NULL source, so a table too large to finish in one pass
continues on the next call.
:::

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

> **Sort and filter by the column name, not the name you read back.** The
> system timestamps are serialized camelCased — a row comes back with
> `createdAt` / `updatedAt` — but `sort` and `filter` address **columns**, so
> both take `created_at` / `updated_at`. `sort=-createdAt` is a
> `422 Cannot sort on field: createdAt`, and `filter={"createdAt":…}` is the
> matching `Cannot filter on field`. Same for `owner_id` on an owner-scoped
> collection, which reads back as `ownerId`. Your own fields keep their
> snake_case name on both sides, so this only bites on the system columns.

### Text sorts are byte order, not alphabetical order

`ORDER BY` on a text column uses the **database's** collation, and on
SQLite/D1 that is byte order over UTF-8. For ASCII text the two agree, so this
is invisible in English and then wrong everywhere else — every letter outside
A–Z sorts *after* `Z`, because its UTF-8 encoding starts above `0x7A`.

Measured on a Turkish customer list, `sort=name`:

```
what you get : Adalar < Işık < Sarı < Zeytin < Çınar < Öztürk < Şahin
tr-TR        : Adalar < Çınar < Işık < Öztürk < Sarı < Şahin < Zeytin
```

`Ç`, `Ö` and `Ş` land past `Zeytin`. The same shape hits German `ä/ö/ü`,
Scandinavian `å/æ/ø`, Polish `ą/ć/ł`, Spanish `ñ`, and every non-Latin script.

There is no per-request knob for this, and the workspace locale does not change
it: D1 ships without SQLite's ICU extension, so `COLLATE` has no locale-aware
collation to name. On Postgres the answer is whatever collation the column was
created with — usually the database's, which a self-host *can* set.

What works today, cheapest first:

1. **Sort one page in the client** with `Intl.Collator(locale)` when the list
   fits a page (`limit` ≤ 200). Correct, and free.
2. **Sort by a column that is already ASCII** — a code, a sequence number, a
   slug — and show the display name beside it. Most operational lists have one.
3. **Keep a sort-key column** written next to the display value (case folded,
   diacritics stripped, transliterated) and `sort` by that. The only option
   that stays correct across pages.

Numbers, timestamps, money and booleans are unaffected — this is text
collation only.

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
`relation_many` sub-field projection works too (`fields=tags.name` → each
inlined tag trimmed to `{ id, name }`). Multi-hop projection (`a.b.c`) still
returns `422` (use `filter`/`sort` for those, or expand one hop). Under the
hood this reuses the `expand` path — a shared JOIN alias for to-one relations,
the batch fetch for `relation_many`.

## Aggregation

The list endpoint only returns rows — it has no grouping or aggregate
functions. For totals, averages, counts, or "top N by metric" analytics, use
the dedicated aggregate endpoint:

```
POST /api/items/<collection>/aggregate
{ "agg": "sum", "field": "total", "groupBy": "customer_id",
  "filter": { "placed_at": { "_gte": { "$now": { "sub": { "months": 1 } } } } },
  "limit": 10 }
```

- `agg` — `count` | `sum` | `avg` | `min` | `max`. `count` ignores `field`;
  the others require a numeric `field`.
- `groupBy` — optional column; each distinct value yields a `{ label, value }`
  row, ordered by `value` desc and capped by `limit` (default 50, max 200).
  Without `groupBy` the result is a single `{ value }`.
- `filter` — same grammar as the list endpoint, applied before aggregation.
- **Multi-select columns group by their ELEMENTS** — a `json` field with
  choices holds an array, so grouping by it counts each chosen value once
  rather than bucketing whole arrays (`["a","b"]` and `["b","a"]` would
  otherwise be two different bars, and neither would answer "how many chose
  b"). A row appears once per value it holds, so the counts can sum to more
  than the number of rows; rows whose column is null or not an array land in
  no bucket. `relation_many` is deliberately left alone — its elements are
  foreign ids, and labelling a chart with ids needs a join aggregate can't do.
- **Permission + tenant gated** — the caller's read `whereSql` is AND-ed in and
  the `field`/`groupBy` columns must be readable; tenant scope is enforced.
- **Single-table only** — no relation traversal (the agg target and `groupBy`
  are plain columns of the collection).

The same engine backs dashboard `items-aggregate` panels and the
`collections.aggregate` MCP tool (so Ask AI can answer analytics questions).

## Indexes (performance)

Flag a field `indexed: true` (in the create/update collection payload, or the
Add Field dialog's "Indexed" toggle) to get a plain B-tree index on its column —
worth it for fields you frequently `filter`/`sort` by. The schema applier emits
`CREATE INDEX IF NOT EXISTS` additively on both PG and SQLite. `unique` fields
are already indexed by their UNIQUE constraint, so `indexed` is skipped for
them; adopted tables get no DDL. For "one row per pair" — a join table's
identity, which a per-column `unique` cannot express — see
[Unique together](/docs/unique-together/). Indexing trades a little write cost for read
speed — opt-in per field. Note that `_contains` (`LIKE %x%`) and the
case-insensitive `_icontains` can't use a plain B-tree index — a substring
search needs a trigram/`pg_trgm` (PG) or FTS index, which Backlex doesn't manage
automatically.

## Pagination

Two modes. `limit` is `[1, 200]` (default `50`) in both, and a value outside
that range is **refused with `422`**, not clamped — `limit=500` comes back as
`limit: Too big: expected number to be <=200`. Ask for 200 and page, rather than
asking for more and assuming the server will trim it for you.

**Offset (default).** `offset` is non-negative (default `0`). Simple and
random-access (jump to any page), but O(offset): the engine walks and discards
every skipped row before the page window, so deep pages get linearly slower,
and a concurrent insert can shift rows across page boundaries (a row seen twice
or skipped). Fine for shallow, human-paged admin lists.

**Keyset / cursor (`cursor`).** Opt in by sending the `cursor` param — pass an
empty value (`?cursor=`) for the first page, then echo back each response's
`next_cursor` to page forward. The server appends a unique `id` tiebreaker to
your `sort` and *seeks* straight past the previous page's last row instead of
counting from zero, so every page is O(page size) regardless of depth and is
stable under concurrent inserts. This is the right mode for feeds, infinite
scroll, and exporting a whole collection. When `cursor` is present `offset` is
ignored, and the response carries `next_cursor` (null on the last page) instead
of `offset`.

```jsonc
// page 1
GET /api/items/orders?sort=-created_at&limit=50&cursor=
// → { "data": [...], "limit": 50, "has_more": true, "next_cursor": "eyJ2Ijp…" }

// page 2 — echo the cursor back
GET /api/items/orders?sort=-created_at&limit=50&cursor=eyJ2Ijp…
```

`has_more` is returned in **both** modes (`true` when a further page exists). It
costs no extra query: the handler fetches `limit + 1` rows and reports whether
the spare row showed up. The cursor is opaque base64url — don't parse it; it is
only valid for the exact `sort` it was minted under, and a stale/edited cursor
is a `422`, not a `500`. Keyset assumes the leading sort columns are non-null
(the default `created_at` + `id` tiebreaker always are); sorting a cursor page
on a nullable column is the caller's risk.

## Metadata (`meta`)

`meta=filter_count` adds `meta.filter_count` (rows matching `filter` +
permission + tenant scope). `meta=total_count` adds `meta.total_count`
(rows matching permission + tenant scope only — the caller's full
slice). `meta=*` gives both. Each count is one extra `SELECT COUNT(*)`, only
run when requested — prefer `has_more` (free) when you just need "is there
another page?" rather than an exact total.

## Localized fields (`locale`)

Collections with `localized` fields store each value per-locale in a
translations sidecar. `?locale=tr` projects every `localized` field down to that
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

- **Up to 3 hops** (4 dotted segments). `a.b.c.d.e` returns `422`. Each
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
| More than 3 hops (`a.b.c.d.e`)                                  | 422    | `Nested filter exceeds max depth: a.b.c.d.e`                       |
| Relation path whose SQL alias would exceed 63 chars (Postgres)  | 422    | `Relation path "…" is too deeply nested to query: …`                |
| More than 20 distinct relation paths in one query               | 422    | `Filter and sort reach through N different relation paths; …`      |
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

### Chaining

An entry may be a path, up to the same 3-hop ceiling as a nested filter:

```bash
curl '/api/items/orders?expand=customer_id.address_id.country_id'
```

```jsonc
{ "id": "…", "title": "Order-1",
  "customer_id": { "id": "…", "name": "Alice",
    "address_id": { "id": "…", "city": "Berlin",
      "country_id": { "id": "…", "name": "Germany" } } } }
```

Each hop is one more LEFT JOIN aliased by the full chain prefix — so it is the
**same** join the nested-filter walker emits, and naming the same path in both
places still produces one ladder. Two entries under one head (`a.b` and `a`)
build one object with the nested key added, not two competing selects for the
same column. A null FK partway down nests `null` rather than an object of
nulls, exactly as the top level does.

The permission cascade below applies at **every** hop: each loads its target
collection and resolves `read` on it, so a chain can reach nothing a plain
expand of that collection would refuse.

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

### Expanding a `relation_many` (to-many) field

`expand=<rel_many_field>` works too — a `relation_many` field stores an
array of foreign ids, so it inlines to an **array of target rows**:

```bash
curl '/api/items/posts?expand=tags'
```

```json
{
  "data": [
    {
      "id": "p-1",
      "title": "Hello",
      "tags": [
        { "id": "t-1", "name": "Red", "color": "#f00" },
        { "id": "t-2", "name": "Blue", "color": "#00f" }
      ]
    }
  ]
}
```

Unlike the to-one path (a LEFT JOIN, which would multiply rows for a
to-many relation), this runs as a **single batched fetch per head**: the
list handler collects every referenced id across the whole page, fetches
the target rows in one `… WHERE id IN (…)` query, and substitutes each
row's id array with the ordered array of inlined rows. A 50-row page with
`expand=tags` is two queries total, not 51.

- **Order is preserved** from the stored id array.
- **Dangling ids are dropped** — an id with no live, tenant-visible,
  non-soft-deleted target row is silently omitted (the array only carries
  rows the caller could read directly). An empty array stays `[]`.
- **Same permission + tenant gate** as the to-one path: action-level
  `read` on the target collection (`403` otherwise) and the target's
  `fields` allow-list trims each object's keys.
- **Sub-field projection** works via `fields=tags.name` (routes `tags`
  into expand and trims each object to `id` + the requested leaves). As
  with to-one, naming the head in `expand=` too means "expand whole" and
  wins over the trim.

### Null relations

A null source FK (`customer_id IS NULL`) returns `"customer_id": null`
in the response, NOT `{id: null, …}`. The CASE wrapper enforces this so
unset relations look the same expanded or not.

### Edge cases and 4xx messages

| Situation                                                       | Status | Message                                                            |
|-----------------------------------------------------------------|--------|--------------------------------------------------------------------|
| `expand` chain deeper than 3 hops                               | 422    | `expand exceeds max depth: <field>`                                |
| `expand` chain through a `relation_many` head                   | 422    | `Cannot chain through a relation_many field: <field>`              |
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
target rows through differential response shape, so Backlex treats
the join as a read against the target and refuses to compile it when
the caller can't read directly either.

When joins are present the source permission's `whereSql` is also
recompiled through the join-aware column resolver, so a condition like
`{ owner_id: { _eq: "$user.id" } }` is pinned to the base table and
doesn't ambiguously resolve against the joined target's `owner_id`.

## What's not yet supported

- **Beyond 3 hops** — `a.b.c.d.e` and deeper return `422`. The ceiling is
  about how legible a JOIN ladder stays in `EXPLAIN`, and nothing else.
  It used to be 2 hops and used to claim it kept alias lengths under
  Postgres's 63-character identifier limit; it did not, because field names
  have no length limit of their own, so two long ones already overflowed at
  two hops and PG silently truncated the two aliases into one — wrong rows,
  no error. `relationAlias` measures the alias per path now and refuses one
  Postgres would truncate (SQLite has no such limit, so the check is
  Postgres-only rather than a limit invented for every dialect).
- **Multi-hop through `relation_many`** — only single-hop
  `relation_many` filters lower to `EXISTS`. A multi-hop chain whose
  middle (or last) segment is a `relation_many` field returns `422` —
  joining through a JSON array of foreign ids needs a different
  lowering (LATERAL unnest on PG, sub-SELECT on SQLite) that doesn't
  compose cleanly with the LEFT-JOIN ladder. Tracked as a follow-up.
- **Sorting through `relation_many`** — there's no well-defined order
  across the array's members; filter is supported via `EXISTS`, sort
  still returns `422`.
~~**`?expand=` chain (`a.b`)**~~ — **shipped.** `?expand=customer_id.address_id`
  inlines the address inside the customer, up to the same 3-hop ceiling, and
  the JOIN is shared with the nested-filter ladder when both name the same
  path. Every hop loads its target and resolves `read` on it, so a chained
  expand can reach nothing a plain expand of that collection would refuse.
  Chaining THROUGH a `relation_many` head is still `422` — a to-many head is
  batch-fetched after the page materializes, so there is no joined row to hang
  a further hop off.
~~**`?expand=` on a `relation_many` field**~~ — **shipped.** To-many heads are
  batch-fetched after the page is materialized rather than joined, so no
  `LATERAL`/`json_group_array` lowering was needed after all. This entry
  described a limit that had already been lifted.

## SDK fluent query builder

The public SDK (`backlex`) ships a chainable, type-safe builder that
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

## Optimistic concurrency (conflict guard)

A plain `PATCH` is last-write-wins: two people saving the same row silently
overwrite each other. To opt into conflict detection, send the `updatedAt`
you loaded the row with as a precondition:

```http
PATCH /api/items/posts/p1
x-if-unmodified-since: 2026-07-16T12:00:00.000Z

{ "title": "my edit" }
```

If the row's `updatedAt` still matches, the update applies as usual. If
someone saved in between, the write is refused:

```json
// 409
{ "error": {
  "code": "CONFLICT",
  "message": "This record was modified after you loaded it",
  "details": { "currentUpdatedAt": "2026-07-16T12:03:41.512Z" }
} }
```

Timestamps are compared as epoch milliseconds, so any parseable format works.
An unparseable value is a `422`. The guard is **opt-in and per-request**:
requests without the header keep last-write-wins, and batch / bulk-update /
GraphQL writes are unaffected. The SDK exposes it on `update`:

```ts
await client.from("posts").update(id, patch, { ifUnmodifiedSince: row.updatedAt });
```

The admin item editor sends the precondition on every save and turns a `409`
into a conflict banner (reload the latest version, or save anyway to
overwrite).

## Batch & transactional writes

`POST /api/items/:slug/batch` runs many create/update/delete operations on one
collection in a single request:

```http
POST /api/items/posts/batch
{
  "operations": [
    { "op": "create", "data": { "title": "A" } },
    { "op": "update", "id": "p1", "data": { "title": "renamed" } },
    { "op": "delete", "id": "p2" }
  ],
  "atomic": false
}
```

Every operation goes through the **same** validation, permission, vectorize,
event, audit and revision pipeline as the single-item endpoints — a batch is not
a shortcut around them. Permissions are resolved per action (`create` / `update`
/ `delete`); `update` and `delete` require `id`. Up to **100** operations per
request.

### Partial-success (default)

Each operation is independent. The response reports per-row results; a failing
row never blocks the others:

```json
{ "data": {
  "atomic": false, "total": 3, "succeeded": 2, "failed": 1,
  "results": [
    { "index": 0, "op": "create", "ok": true, "id": "…", "data": { … } },
    { "index": 1, "op": "create", "ok": false, "error": { "code": "VALIDATION", "message": "…" } },
    { "index": 2, "op": "delete", "ok": true, "id": "p2" }
  ]
} }
```

### Atomic (`atomic: true`)

All operations commit together or not at all — the first failure rolls the whole
batch back and returns the error (e.g. `422` / `404`) naming the operation
index; nothing is written.

| Runtime | `atomic: true` |
|---|---|
| Postgres (postgres-js / TCP) | ✅ |
| Self-host SQLite (Bun) | ✅ |
| D1 / libSQL / neon-http (HTTP transports) | ❌ → `409` (use partial-success) |

Atomic mode does **not** support intra-batch read-after-write: an operation
can't see an earlier operation's write in the same batch (e.g. create a row then
update it by id in one atomic call). Split those across two requests, or use a
Postgres deployment where the ops are independent.

### SDK

```ts
await client.from("posts").createMany([{ title: "A" }, { title: "B" }]);
await client.from("posts").updateMany([{ id: "p1", data: { title: "x" } }], { atomic: true });
await client.from("posts").deleteMany(["p2", "p3"]);
await client.from("posts").batch([
  { op: "create", data: { title: "A" } },
  { op: "delete", id: "p2" },
], { atomic: true });
```

## Bulk-update a selection

`POST /api/items/:slug/bulk-update` applies **one shared patch** to a list of
selected ids — the "set these fields on every selected row" case, without
expanding it into N separate `update` operations:

```http
POST /api/items/posts/bulk-update
{
  "keys": ["p1", "p2", "p3"],
  "data": { "status": "archived", "featured": false }
}
```

Only the fields named in `data` change on each row; everything else is left
untouched. The shared patch is validated **once** up front (a bad payload is a
single `422`/`403`, not N identical row failures), then each key runs through the
same permission / validation / vectorize / event / audit / revision pipeline as a
single `PATCH`. Up to **1000** keys per call.

It is **partial-success**: a key the caller can't write (filtered by the
permission's row condition or tenant scope) is reported per-row as `NOT_FOUND`
and counted in `failed`; the rest still commit.

```json
{ "data": {
  "total": 3, "updated": 2, "failed": 1,
  "results": [
    { "id": "p1", "ok": true },
    { "id": "p2", "ok": true },
    { "id": "p3", "ok": false, "error": { "code": "NOT_FOUND", "message": "Item not found" } }
  ]
} }
```

Structured / multi-value / localized fields (`json`, `file`, `relation_many`,
`localized` fields) are **rejected** for bulk — edit those per record. The admin's data
table exposes this via row-select → **Edit**, where only the fields you touch are
sent.

## Bulk export / import

To pull a whole collection out (JSON or CSV) or bulk-load rows back in, see
[Backup, restore & export](/docs/backup-restore#per-collection-export--import). Export
applies the same read filters as `list`; import runs each row through the normal
create path.
