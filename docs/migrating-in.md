---
title: Migrating an external database in
description: Copy an existing Postgres database into backlex — introspect, plan, run, verify — with primary keys preserved.
---

`backlex import-db` moves data **into** backlex from a database you already
have. It's the complement of [adoption](/adopting-tables/): adoption wraps a
table that lives in the *same* database backlex runs on; import-db **copies**
rows from an *external* source — a legacy Postgres, a Supabase project, a
Heroku add-on — into managed collections. Cloud workspaces run on D1, so for
them copying is the only way in.

The pump runs client-side in the CLI, on purpose: your source database is
usually firewalled away from the internet, but the machine you run the CLI on
can reach both it and your backlex instance. The server side is one endpoint —
a bulk, idempotent, PK-preserving ingest.

## The three steps

```bash
# 1. See what's there
backlex import-db inspect --source postgres://user:pass@host/db

# 2. Emit an editable plan
backlex import-db plan --source postgres://… --out migration.json

# 3. Review migration.json, then copy + verify
backlex import-db run migration.json --source postgres://…
```

Target connection resolves like every other CLI command (`--url` / `--key` /
`--tenant` / saved profile); the key needs the admin role. The source URL can
also come from `BACKLEX_IMPORT_SOURCE`.

Three source engines, picked from the URL:

| Source | URL shape | Notes |
|---|---|---|
| Postgres | `postgres://user:pass@host/db` | also the only server-side engine |
| MySQL / MariaDB | `mysql://user:pass@host/db` | CLI-only (mysql2) |
| SQLite file | `sqlite:./legacy.db` or `*.sqlite`/`*.db` path | CLI-only, needs Bun |
| MongoDB | `mongodb://host:27017/db` (or `mongodb+srv://`) | CLI-only; schema inferred by sampling |
| Firestore | `firestore://<project-id>` | CLI-only; driver installed separately |
| DynamoDB | `dynamodb://<region>[?endpoint=…]` | CLI-only; driver installed separately |

MySQL idioms map automatically: `tinyint(1)` → boolean, `enum(…)` → text +
dropdown choices, `mediumtext`/`longtext` → longtext, `set` → text (warning).

### Schemaless sources (MongoDB / Firestore / DynamoDB)

Document stores have no schema catalog, so `plan` **infers** one by sampling
documents (default 500 per collection, `--sample-size <n>` to widen):

- Field union across the sample; per-field majority typing (string → text /
  longtext by length, int vs float, boolean, `Date` → timestamp). Nested
  objects/arrays — and any field whose sampled types disagree — become
  `json`. Fields missing from part of the sample are nullable.
- **The document key is the preserved primary key**, surfaced as `_id`:
  Mongo's `_id` (hex ObjectIds as 24-hex text), Firestore's document id, or
  Dynamo's partition-key value (numeric keys → `integer` pk). Resume cursors
  round-trip through the plan state file transparently.
- The caveat rides in the plan itself, per table: *keys outside the sampled
  set are not copied* — widen the sample or add the field to the plan by
  hand. There are no foreign keys to introspect, so no `relation` fields are
  auto-wired; because ids are preserved, you can flip a field to
  `{"type": "relation", "to": "<slug>"}` in the plan file and it will resolve.
- `--since` works the same as SQL sources (the detected `updatedAt` /
  `createdAt` field, compared as dates). On Firestore the filter is applied
  client-side while scanning (no composite index needed); on Dynamo it's a
  scan `FilterExpression` compared against the attribute's stored
  representation.

Store-specific notes:

- **Firestore** — auth via the standard Google chain
  (`GOOGLE_APPLICATION_CREDENTIALS`); **root collections only**
  (subcollections don't surface — flatten them upstream or copy per-path
  later). `Timestamp` → timestamp, `DocumentReference` → its path string,
  `GeoPoint` → `{latitude, longitude}` json.
- **DynamoDB** — auth/region via the standard AWS chain; `?endpoint=` targets
  DynamoDB Local. Only **partition-key-only** tables are copyable —
  HASH+RANGE tables are excluded with the composite-key reason (the surfaced
  key wouldn't be unique). Verify uses exact `Select=COUNT` scans (the
  table's `ItemCount` lags hours). String sets/number sets → arrays; binary
  attributes are dropped like SQL `bytea`.
- The Firestore/Dynamo drivers are **not** bundled with the CLI (a Postgres
  user shouldn't download the AWS SDK) — on first use it tells you what to
  install: `@google-cloud/firestore`, or `@aws-sdk/client-dynamodb` +
  `@aws-sdk/util-dynamodb`.

## Primary keys are preserved

This is the load-bearing design decision. Every copied row keeps its source
primary key, so every foreign-key value in the source stays valid in the
target — `orders.customer_id = 42` still points at customer 42. No remap
table, no fixups.

To make that possible, managed collections gained a **`pkType`**
(`uuid` | `text` | `integer`, on `POST /api/collections`). The plan sets it
from the source PK's type, and the physical `id` column is created to match
(`bigint` PKs land in a `bigint`/`INTEGER` column, not a `uuid` one).

One behavioral consequence: an **integer-keyed** collection never
auto-generates ids — `POST /api/items/<slug>` requires the key in the body,
the same contract adopted tables have. `uuid`/`text` collections keep
auto-generating UUIDs.

## The plan file

`plan` introspects every table (or `--tables a,b,…`) and writes a JSON
document you're meant to edit before running:

- **`order`** — copy order, FK parents first (topologically sorted).
- **`tables[].include`** — tables without a usable single-column PK come out
  `include: false` with a `reason`; flip tables you don't want to `false`.
- **`tables[].slug` / `fields[].name`** — rename freely (source column names
  are `snake_case`d automatically; reserved names like `owner_id` get a
  `_src` suffix).
- **`fields[].type`** — the mapped backlex type. Migration is more permissive
  than adoption because it copies into columns *we* create:

| Source | Becomes | Notes |
|---|---|---|
| enum | `text` + dropdown choices | labels introspected from `pg_enum` |
| array (`text[]`, …) | `json` | element type not preserved |
| `numeric` / `decimal` | `number` | double precision — exactness warning |
| single-column FK | `relation` | when the target table is in the plan |
| `bytea` / geometry / unknown | *excluded* | listed in `warnings` |

- **`createdAtColumn` / `updatedAtColumn`** — pattern-detected source columns
  (`created_at`, `inserted_at`, …) whose values are copied into the target's
  system timestamps instead of becoming regular fields.

Nothing is dropped silently: every lossy mapping, excluded column, skipped
table, and FK cycle lands in `warnings` / `reason`.

## What `run` does

For each included table, in plan order:

1. **Ensure the collection** — `GET /api/collections/<slug>`; 404 →
   `POST /api/collections` with the plan's fields + `pkType`. Existing
   collections are reused (that's the resume path).
2. **Copy** — keyset-paged reads from the source (`WHERE pk > cursor ORDER BY
   pk LIMIT n`, never OFFSET), transformed (column→field renames, system
   timestamp hoisting), and POSTed to
   `POST /api/admin/migrate/ingest/<slug>` in batches (`--batch`, default
   1000, max 2000).
3. **Verify** — source `COUNT(*)` vs the target's tenant-scoped count; the
   summary prints ✓/✗ per table and the process exits non-zero on mismatch.

Progress (per-table PK cursor) persists in `<plan>.state.json` after every
batch. If anything dies mid-copy, re-run with `--resume` — the ingest is
idempotent, so overlap is harmless. `--dry-run` prints what would happen.

## The ingest endpoint

`POST /api/admin/migrate/ingest/:slug` — admin + platform plane + active
workspace, managed collections only (an adopted table already owns its data).
Body: `{ "rows": [ … ] }`, ≤ 2000 rows.

Deliberate differences from the normal create path:

- **PKs and timestamps are preserved**, not stripped — `id`, `created_at`,
  `updated_at` (and `_status` / `deleted_at` where the collection has them)
  are honored from the row. Versioned collections default migrated rows to
  `published` (a `draft` default would make the whole dataset invisible).
- **`INSERT … ON CONFLICT DO NOTHING`** — existing rows are never
  overwritten; re-sending a batch skips them (`skipped` in the response).
- **No per-row side-effects** — no revisions, realtime events, webhooks, FTS
  or vector indexing. A million-row copy can't afford them. Backfill search
  indexes afterwards with the existing `POST /api/items/<slug>/fts-reindex` /
  vectorize endpoints if the collection uses them.
- **Structural validation only** — unknown columns, missing PKs, and NULLs in
  required fields fail *their row* (reported in `failed[]`), not the batch.
  Soft validation rules and per-row relation checks are skipped; the verify
  step owns integrity (this is also what makes FK cycles copyable).
- Statements are **chunked** to stay under D1's ~100 bound-parameter cap;
  there's no transaction envelope (D1 can't), idempotency covers retries.

Response:

```json
{ "data": { "received": 500, "inserted": 498, "skipped": 0,
            "failed": [{ "index": 7, "error": "Unknown column \"totl\"" }],
            "total": 10498 } }
```

`total` is the target's row count after the call — the CLI's verify compares
it against the source.

## The pre-cutover delta pass (`--since`)

A live source keeps changing while you migrate. The cutover recipe:

1. **Full copy** while the source stays live: `import-db run migration.json …`
2. Stop (or pause writes on) the source.
3. **Delta pass** for everything that changed since the full copy started:

```bash
backlex import-db run migration.json --source … --since 2026-07-03T09:00:00Z
```

`--since` reads only rows whose detected `updated_at` (falling back to
`created_at`) is `>=` the watermark and sends them in **upsert** mode: PK
conflicts overwrite in place — `created_at` and the workspace are preserved,
`updated_at` moves forward. Tables with neither timestamp column are copied
in full (with a warning), still upserted. The summary reports
`copied`/`updated` per table instead of comparing counts (a delta is by
design smaller than the table). Delta passes keep their own
`<plan>.since.state.json`, so a finished full copy's cursors don't
short-circuit them; `--resume` works the same way.

4. Verify, then point your application at backlex.

There is deliberately no continuous CDC — the watermark pass is repeatable,
so run it as many times as you like until the diff window is minutes wide.

## Server-side runs (the admin wizard)

When the source database is reachable **from the backlex server** (Supabase,
Neon, RDS with a public endpoint, …), you don't need the CLI at all — the
admin's **Data → Database import** page drives the same engine server-side:

1. **Save a source** — name + `postgres://` URL. The connection string is
   encrypted at rest with `AUTH_SECRET` (same envelope as integration
   secrets) and only ever returned masked (`postgres://host:5432/db`).
2. **New migration** — pick tables, review the generated plan (same
   `packages/migrate` plan builder as the CLI: warnings, exclusions, copy
   order), and start. Slugs that collide with an existing collection of a
   **different shape** (template-seeded workspaces usually already have
   `customers`, `orders`, …) are auto-renamed (`customers_2`) with a warning;
   compatible collisions are reused — that's the resume path. `startRun`
   hard-rejects hand-edited plans that reintroduce an incompatible collision,
   and the CLI's `run` does the same check before copying.
3. **Watch it run.** The run executes on the scheduler tick in bounded
   slices: per-table keyset cursors persist in the `migration_runs` row after
   every batch, a stale lease is reclaimed by any isolate, and the write path
   is the same idempotent ingest — so an isolate death mid-copy costs
   nothing. Cancel any time; resume continues from the cursors.

The equivalent API surface exists everywhere (multi-surface parity):
REST `/api/admin/migrate/sources|runs`, SDK `client.migrate.*`, GraphQL
`migrateSources/migratePlan/migrateStartRun/…`, MCP `migrate.*`, and CLI
`backlex import-db sources|server-plan|start|status|cancel|resume`
(`status --watch` polls until the run settles).

### SSRF guard

A hosted admin must not be able to use the server as a proxy into private
infrastructure, so source URLs pointing at private/internal addresses
(localhost, RFC1918, link-local — including cloud metadata endpoints — ULA,
`.local`/`.internal`) are **rejected by default**. Self-hosters whose source
DB legitimately lives next to backlex opt in with
`MIGRATE_ALLOW_PRIVATE_SOURCES=true`. The CLI pump has no such restriction —
it runs on your machine, inside your network.

### One run at a time

A workspace can have one `pending`/`running` migration at a time, and a
source can't be deleted while its run is in flight. Runs are kept (newest 50
listed) with their final per-table verify state.

## Limits & scope

- **Server-side runs are Postgres-only.** MySQL and SQLite-file sources go
  through the CLI (their drivers don't belong in the Worker bundle).
- **No continuous CDC.** The `--since` delta pass covers cutover; a streaming
  replication mode is out of scope.
- **Composite PKs** can't key a collection — those tables are excluded with a
  reason (add a surrogate key upstream, or copy manually).
- Binary columns (`bytea`/`blob`) don't ride along — move blobs to storage
  separately.

## Worked example

```bash
$ backlex import-db plan --source postgres://app:…@db.internal/shop --out migration.json
✓ plan → migration.json (7/9 tables included)
  ⚠ orders: decimal column "total" copied as double-precision number — …
  ⚠ products: enum column "status" copied as text with dropdown choices (3 values) — …
  ✗ audit_log excluded: no single-column primary key …

$ backlex import-db run migration.json --source postgres://… --url https://api.example.com --key pak_…
✓ created collection customers
  customers: 41250 copied
✓ created collection orders
  orders: 187301 copied

Migration summary
  ✓ customers → customers: source=41250 target=41250 copied=41250
  ✓ orders → orders: source=187301 target=187301 copied=187301

All tables verified. You can delete migration.json.state.json now.
```
