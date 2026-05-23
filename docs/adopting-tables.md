---
title: Adopting existing tables
description: Point a collection at a table you already own — no DDL, no migrations.
---

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

### 3. Metadata + create

`POST /api/collections` with `{ adopted: true, physicalTable, slug,
singular, plural, fields, pkColumn, hasCreatedAt, hasUpdatedAt,
createdAtColumn, updatedAtColumn, ownerIdColumn, ownerScoped }` is
atomic: writes the `collections` row (with `adopted = true`,
`physical_table = <your table>`, `pk_column`) and seeds default
permission rows. No DDL — `applyCollection` short-circuits when
`adopted = true`. The same endpoint handles managed collections when
`adopted` is omitted or `false`; **there is no separate
`/adopt/apply`** anymore.

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

## Archive and restore

`DELETE` on an adopted collection is **soft**: the row stays put with
`status = 'archived'` and an `archived_at` timestamp, the physical table
is never touched, and a single `POST .../restore` brings everything
back. Managed collections still hard-delete — there's no row to recover
because the data only ever lived inside workeros. The split keeps both
sides honest: adopted data outlives the collection, managed data doesn't.

### What "archive" means

`DELETE /api/collections/<slug>` on an adopted collection sets
`status = 'archived'` and `archived_at = now()` on the `collections`
row. The physical table is left alone — that's the whole adoption
contract, and Directus #24411 is the footgun we're explicitly not
shipping. Metadata (fields, permissions, aliases, FK relations) is
preserved so restore is lossless. While archived, `/api/items/<slug>`
endpoints return `404 Collection not found`, and the row is hidden from
the default collection list.

### Restore

```bash
curl -sX POST localhost:5173/api/collections/<slug>/restore
```

Sets `status = 'active'`, clears `archived_at`, and re-seeds the
`authenticated`-role owner-scoped permissions via the same
`seedOwnerScopedPermissions` helper from Phase 1. One round-trip and
the collection is back on the API, the realtime channel, and the admin
UI. Restore is a no-op for managed collections (there's no archived
state to leave) and an error for collections that were never archived.

### Default vs all

`GET /api/collections` returns only `status = 'active'` rows by default.
Pass `?include_archived=true` to fold the archived ones back in — the
admin UI uses this to render the "Archived" tab. Single-collection
lookup follows the same rule: `GET /api/collections/<slug>` 404s on an
archived row unless you pass `?include_archived=true`.

### Managed collections

Managed collections (the ones whose physical table is `c_<slug>`) still
hard-delete: the `c_<slug>` table is dropped, the metadata row is gone,
and there is no restore. The asymmetry is on purpose — for an adopted
table the data lives in some other application and the user owns it, so
deleting the wrapper can't be irreversible. For a managed table the
data only ever lived in workeros, so `DELETE` means what it says.

### Worked example

```bash
# Adopt + later archive + restore
curl -sX POST localhost:5173/api/collections \
  -d '{"adopted":true,"physicalTable":"legacy_orders","slug":"legacy_orders","pkColumn":"id","fields":[...]}'

# Some time later — admin archives
curl -sX DELETE localhost:5173/api/collections/legacy_orders
# Response: {"ok": true, "archived": true}

# Items endpoint now 404s
curl -sX GET localhost:5173/api/items/legacy_orders
# 404 "Collection not found"

# Restore
curl -sX POST localhost:5173/api/collections/legacy_orders/restore
# Response: {"ok": true}

# Items endpoint works again — the data was never gone
curl -sX GET localhost:5173/api/items/legacy_orders
# 200, returns the rows that were always in the physical table
```

## Aliasing existing columns

Adopted tables rarely follow workeros' conventional column names —
they have `inserted_at` instead of `created_at`, `user_id` instead of
`owner_id`. **Aliasing** lets a collection treat one of your columns
*as* a system field without renaming or copying it. The original
column stays put; workeros just learns where to look. This keeps
adoption truly DDL-free: no `ALTER TABLE` to add a duplicate column,
no backfill, no drift between your migration tool and ours.

### How it works

Three nullable columns on `collections` carry the mapping:
`created_at_column`, `updated_at_column`, `owner_id_column`. When set,
the items router emits the alias at SQL level —
`SELECT inserted_at AS created_at` — and rewrites `sort` / `filter`
parameters that target the conventional name onto the underlying
column. The wire shape is unchanged: API consumers always see
`createdAt`, `updatedAt`, `ownerId`. Sort `?sort=-created_at` works
against `inserted_at` transparently.

### Auto-suggestions

`POST /api/admin/adopt/inspect` scans your columns for common naming
patterns and returns an `aliasSuggestions` block the wizard preselects:

```json
{
  "aliasSuggestions": {
    "createdAt": "inserted_at",
    "updatedAt": null,
    "ownerId": "user_id"
  }
}
```

Patterns matched (case-insensitive, snake or camel):

- **createdAt** — `inserted_at`, `created_at`, `date_created`,
  `created`, `insert_time`, `createdAt`, `dateCreated`
- **updatedAt** — `modified_at`, `updated_at`, `last_modified`,
  `updated`, `modify_time`, `updatedAt`, `modifiedAt`, `lastModified`
- **ownerId** — `user_id`, `owner_id`, `created_by`, `author_id`,
  `owner`, `owned_by`, `userId`, `createdBy`, `authorId`, `ownedBy`

A suggestion is only emitted when the column's inferred FieldType also
satisfies the alias type constraint (see below).

### Ownership alias

`ownerIdColumn` is the special one: when set, the items router reads
ownership straight from that column on your table and **skips the
`item_ownership` side-table entirely** — no JOIN, no sync writes on
INSERT/DELETE. Pick the alias when your table already has an
authoritative `user_id` (and you want permission filters to compile to
an in-row comparison). Pick the side-table — leave `ownerIdColumn`
null with `ownerScoped: true` — when you want owner-scoping without
touching the source table at all.

### Worked example

```sql
-- A typical adoption with aliasing: legacy table with inserted_at + user_id.
CREATE TABLE legacy_orders (
  id uuid PRIMARY KEY,
  total numeric(10, 2) NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  user_id text NOT NULL
);
```

```bash
# Inspect — note the aliasSuggestions in the response
curl -sX POST localhost:5173/api/admin/adopt/inspect \
  -H 'Content-Type: application/json' \
  -d '{"table": "legacy_orders"}' \
  --cookie better-auth.session_token=...

# Create — explicit alias mapping
curl -sX POST localhost:5173/api/collections \
  -H 'Content-Type: application/json' \
  -d '{
    "adopted": true,
    "physicalTable": "legacy_orders",
    "slug": "orders",
    "pkColumn": "id",
    "ownerScoped": true,
    "createdAtColumn": "inserted_at",
    "ownerIdColumn": "user_id",
    "fields": [...]
  }'

# Read — API returns createdAt + ownerId at the conventional shape
curl -s localhost:5173/api/items/orders?sort=-created_at
```

### Type validation

The create endpoint checks the aliased column's FieldType before persisting:

- `createdAtColumn` / `updatedAtColumn` — must be `timestamp` or
  `integer` (Unix-ms epochs are fine on SQLite).
- `ownerIdColumn` — must be `text`, `longtext`, or `uuid`.

Mismatches return `VALIDATION` with the offending field name.

### Limits

- An aliased column **cannot also appear in the regular `fields`
  list** — the create endpoint rejects the duplicate and the wizard
  surfaces a warning. Pick one role for the column.
- If your table already has a column literally named `created_at` /
  `updated_at` / `owner_id`, leave the alias `null` and use
  `addCreatedAt: true` (etc.) instead — there's nothing to alias.

## Foreign key auto-detection

Adopted tables almost always already have foreign keys — `orders.customer_id
→ customers.id`, the usual shape. The adopt flow now introspects those
constraints and offers to wire each one as a workeros `relation` field, so
items written through the API are validated against the target collection
without you hand-writing a single field definition. Nothing about your
schema changes; the FK stays where it is, and only the collection metadata
gains a relation entry.

### How it works

`POST /api/admin/adopt/inspect` returns a `foreignKeys` array alongside the
existing column list. On Postgres the inspector reads `pg_constraint` and
expands `conkey` / `confkey` via `unnest WITH ORDINALITY`, so composite-FK
column ordering is preserved. On SQLite / D1 it walks `PRAGMA
foreign_key_list(<table>)` and resolves any NULL `to` against the parent
table's PRAGMA-derived primary key. Each row records the source column,
the referenced table + column, and a `composite: true` flag when the
constraint spans more than one column.

The route layer then matches each `referencesTable` against the workspace's
collections by `physical_table`, so both managed (`c_<tenant>_customers`)
and adopted (`customers`) targets are recognised and surface as
`targetCollection: { slug, id }`. Targets that don't yet exist as a
workeros collection come back with `targetCollection: null`.

### The wizard

Step 2 of the adopt wizard renders a **"Foreign keys detected"** panel
listing every FK with its source column, target table, and an **"Adopt as
relation"** toggle. Toggling it adds a `{ type: "relation", to: "<slug>" }`
entry to the apply payload for that column; leaving it off keeps the
column as its inferred scalar type. Rows with `composite: true` are
disabled — workeros relation fields are single-column — and rows whose
target collection isn't in the workspace show a hint to **"Adopt the
target table first"** before coming back.

### Adopt-time vs runtime semantics

Auto-detection only sets up the metadata. The runtime guarantees come from
the Phase 1 integrity checks already in `items.ts`: every write through
`POST` / `PATCH` runs `validateRelations`, which checks that each
`relation` value exists in the target collection (tenant-scoped — you
cannot point at another workspace's row). Failures are mapped to
`VALIDATION` (422).

DB-level violations are mapped the same way: PG's `23503` and SQLite /
D1's `SQLITE_CONSTRAINT_FOREIGNKEY` both surface as 422 to the client.
D1 enforces foreign keys unconditionally; on PG the constraint is enforced
whenever the FK exists on the table (which, for adopted tables, it almost
always does).

### Limits

- **Composite FKs** (multi-column). workeros relations are single-column,
  so composite constraints are detected and shown but not offered as a
  toggle. Define the columns manually as `text` fields if you need them.
- **Cross-schema FKs (PG).** The inspector is scoped to `current_schema()`;
  FKs pointing into another schema don't surface.
- **Cross-DB FKs.** D1 has no `ATTACH`, so adoption is single-DB; PG has
  no cross-database FKs in the SQL standard.
- **`ON DELETE CASCADE`.** Cascaded deletes happen at the DB layer and
  workeros never sees them — no audit row, no webhook fire, no realtime
  event for the cascaded children. If your adopted table relies on
  cascade, treat those deletions as out-of-band.

### Type rules

A detected FK column is offered as `relation` regardless of its underlying
type (`uuid`, `integer`, `text` all work — workeros stores the raw value
and validates membership on write). The schema also supports
`relation_many`, but auto-detect always proposes `relation` because a
single-column FK is by definition to-one; pick `relation_many` manually
when you're modelling a junction table.

### Worked example

```bash
# Inspect — note the foreignKeys
curl -sX POST localhost:5173/api/admin/adopt/inspect \
  -H 'Content-Type: application/json' \
  -d '{"table": "orders"}' --cookie ...

# Response includes:
# "foreignKeys": [{"column": "customer_id", "referencesTable": "customers", ...}]

# Create — customer_id becomes a relation field
curl -sX POST localhost:5173/api/collections \
  -H 'Content-Type: application/json' \
  -d '{
    "adopted": true,
    "physicalTable": "orders",
    "slug": "orders",
    "pkColumn": "id",
    "fields": [
      {"name": "customer_id", "type": "relation", "to": "customers"},
      {"name": "amount", "type": "number"}
    ]
  }' --cookie ...

# Write — invalid relation rejected
curl -sX POST localhost:5173/api/items/orders \
  -d '{"customer_id": "nonexistent", "amount": 50}'
# → 422 "Relation target \"customers\" has no row(s) with id: nonexistent"
```

## What we don't do (and why)

- **DDL on adopted tables.** `applyCollection` short-circuits when
  `adopted = true`; `dropField` rejects the call. The whole point is
  to leave your schema alone.
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

`POST /api/admin/adopt/inspect` suggests `text` / `number` /
`integer` / `timestamp`. `POST /api/collections` with `adopted: true`,
`physicalTable: "products"`, `pkColumn: "id"`, `hasCreatedAt: true`,
`ownerScoped: false` writes the collection row, and
`GET /api/items/products?limit=10` reads straight from the table. The
wizard at **Collections → Import from database** drives the same three
steps; both paths land on the same `POST /api/collections` endpoint.

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
