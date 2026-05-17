# Adopting Existing Tables

workeros normally creates a fresh physical table (`c_<slug>`) for every
collection. **Adoption** is the opposite path: you point a collection at
a table you already have and workeros wraps it with permissions, the
items API, realtime, and the admin UI — without writing a single DDL
statement against your data.

## When to adopt vs create

Adopt when another app already writes to the table, when you want
your own migration tooling to stay the only thing that touches DDL,
or when you want workeros on top of legacy data without backfilling.
Use a normal **managed** collection when the table doesn't exist yet
or when admin-UI field add/remove should alter the physical table.

Out of scope: foreign-key auto-detection (planned), row backfill, and
renaming columns / changing physical types.

## Limits and prerequisites

**Primary key.** Single-column only: `uuid`, `text` / `varchar`,
`integer`, or `bigint`. Composite PKs, views, and partitioned tables
are rejected at inspect.

**Supported column types.**

| Source (PG / SQLite)              | workeros FieldType |
|-----------------------------------|--------------------|
| `varchar(n)` / `text` (n ≤ 255)   | `text`             |
| `varchar(n)` / `text` (n > 255)   | `longtext`         |
| `integer` / `bigint` / `smallint` | `integer`          |
| `numeric` / `real` / `double`     | `number`           |
| `boolean`                         | `boolean`          |
| `json` / `jsonb`                  | `json`             |
| `timestamp` / `timestamptz`       | `timestamp`        |
| `uuid`                            | `uuid`             |

Arrays, enum types, geometry/PostGIS, and custom domains aren't
mapped — inspect flags them, the wizard hides them, and they don't
surface in the items API. The table itself can still be adopted.

**Reserved column names.** `id`, `tenant_id`, `created_at`,
`updated_at`, `owner_id`, `_status`, `_published_at`. If your table
uses one of these the column has to match its workeros role (e.g. `id`
must be the PK). Conflicts surface as warnings on inspect.

## The 3-step wizard

The admin UI lives at **Collections → Import from database**. Each
step maps to one admin endpoint, so the flow scripts cleanly too.

### 1. Pick a table

```bash
curl -b cookies.txt http://localhost:5173/api/admin/adopt/tables
```

Lists every table in the current database minus workeros system
tables (`users`, `sessions`, `roles`, `c_*`, …) and anything already
adopted.

### 2. Map fields

```bash
curl -b cookies.txt -X POST http://localhost:5173/api/admin/adopt/inspect \
  -H 'content-type: application/json' -d '{"table":"products"}'
```

Returns every column, a suggested `FieldType`, and warnings
(unsupported type, reserved name, no PK detected). The wizard renders
this as a toggle plus a type dropdown per column.

Three optional toggles live on this step: **created_at**,
**updated_at**, and **owner-scoped**. The first two are only available
if the column already exists — workeros never adds them. None of these
toggles run DDL; they only set flags on the collection row.

### 3. Metadata + apply

`POST /api/admin/adopt/apply` with `{ table, slug, singular, plural,
fields, pkColumn, addCreatedAt, addUpdatedAt, ownerScoped }` is atomic:
writes the `collections` row (with `adopted = true`, `physical_table`,
`pk_column`) and seeds default permission rows. No DDL —
`applyCollection` is a no-op when `adopted = true`.

## Lifecycle

### Reads and writes after adoption

`GET /api/items/<slug>` and friends work the same as on a managed
collection. The items router reads `pk_column` from the collection
row, so if your PK is `sku`, the URL is still
`/api/items/products/<sku>`.

**POST gotcha.** workeros only auto-generates the PK when
`pk_column = "id"` *and* the column is `uuid`. Any other shape, and
the body must include the PK — otherwise you get a `VALIDATION` error
(`Primary key 'sku' is required in the body`).

### Permissions

Identical to managed collections — same DSL, same role seeding. The
`ownerScoped` flag still seeds an `authenticated`-role permission with
`{ owner_id: { _eq: "$user.id" } }`.

### Ownership

Where `owner_id` lives is the one place adopted and managed
collections diverge:

- **Managed**: `c_<slug>.owner_id`, a column workeros added when it
  created the table.
- **Adopted + ownerScoped**: a sidecar row in
  `item_ownership(collection_id, item_id, owner_id, created_at)`. The
  items router `LEFT JOIN`s it to surface `owner_id`, and INSERT /
  DELETE keep it in sync.

So owner-scoping doesn't add a column to your table — permission
filters resolve via a semi-join against `item_ownership` instead of an
in-row comparison.

### Delete behavior

`DELETE /api/collections/<slug>` on an adopted collection removes the
metadata row, every permission for that collection, and any revisions —
but **does not touch the physical table**. Your data stays. (Directus
issue [#24411](https://github.com/directus/directus/issues/24411)
tracks the inverse footgun on their side, closed "not planned"; we
don't have it.) Drop the table yourself if you want it gone.

## What we don't do (and why)

- **DDL on adopted tables.** `applyCollection` is a no-op when
  `adopted = true`; `dropField` rejects the call. The whole point is
  to leave your schema alone.
- **Foreign-key auto-detection.** Planned. Relations between adopted
  collections are mapped by hand for now.
- **Data migration / row backfill.** Adoption never copies rows.
- **Renaming columns / changing types.** Out of scope — do it in your
  migration layer.

## Worked example

For a Postgres table like:

```sql
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(200) NOT NULL,
  price numeric(10, 2) NOT NULL,
  inventory_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

`/adopt/inspect` suggests `text` / `number` / `integer` / `timestamp`.
`/adopt/apply` with `pkColumn: "id"`, `addCreatedAt: true`,
`ownerScoped: false` writes the collection row, and
`GET /api/items/products?limit=10` reads straight from the table. The
wizard at **Collections → Import from database** drives the same three
steps; both paths land on the same `apply` endpoint.

## Troubleshooting

- **`Primary key 'sku' is required in the body`** — `pk_column` isn't
  `id` and you omitted it on POST. Add the PK field; workeros never
  generates non-`id` keys.
- **`Composite primary keys are not supported`** — change the PK in
  your migration layer, or wrap the table in a view with a
  single-column surrogate (and adopt the view when view support
  lands).
- **`Reserved column name 'owner_id' conflicts`** — your column's name
  is reserved but its type doesn't match. Rename it or skip it in the
  field mapping.
- **`Table is already adopted`** — you can't adopt the same physical
  table twice. Delete the existing collection (metadata-only, data
  untouched) and re-run the wizard.
