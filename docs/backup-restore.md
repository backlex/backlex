---
title: Backup, restore & export
description: Logical JSONL backups (manual + scheduled) with additive restore, plus per-collection CSV/JSON export-import.
---

backlex ships a **logical** backup system: every backup is a portable JSONL
dump of your data, written through the storage adapter (R2/S3/filesystem). It
works identically on all four runtimes and both dialects — unlike a
Cloudflare-D1 point-in-time snapshot, a logical dump moves cleanly between
Postgres and SQLite/D1.

Three things live here:

1. **Backups** — manual or scheduled JSONL dumps of every system table + your
   `c_*` collection tables.
2. **Restore** — re-insert a dump's rows. **Additive**: missing/deleted rows
   come back; existing rows are never overwritten or removed.
3. **Per-collection export/import** — pull one collection's rows out as JSON or
   CSV, and bulk-load rows back in through the normal create path.

All endpoints are admin-only and workspace-scoped.

## Backups

### Manual

```http
POST /api/admin/db/backups/now
{ "label": "before-migration" }
```

Inserts a tracking row, then dumps inline (synchronously) so the response
already carries the final `done`/`failed` status. The dump is one JSONL object
per row — `{"table":"<name>","row":{…}}` — so a restore can stream it without
loading the whole file.

List + download:

```http
GET  /api/admin/db/backups                 # newest first, this workspace
GET  /api/admin/db/backups/{id}/download   # streams the JSONL file
```

Auth-internal tables (sessions, accounts, verifications, passkeys) are
intentionally **excluded** — they hold short-lived secrets and re-syncing them
across a restore is more harmful than helpful.

### Scheduled

Set a per-workspace schedule and retention count:

```http
PUT /api/admin/db/backups/config
{ "schedule": "daily", "retain": 7 }     # schedule: off | daily | weekly
GET /api/admin/db/backups/config
```

The cron tick runs a throttled sweep (`maybeRunScheduledBackups`) that, for
each workspace with a non-`off` schedule, checks the age of the most recent
`auto` backup against the interval, runs one if it's due, then prunes `auto`
backups beyond the newest `retain` (deleting their storage objects too).
**Manual backups are never pruned.**

In the admin, this is the **Database → Backups** tab: the schedule selector
(Off / Daily / Weekly), the retention input, **Back up now**, and per-row
**Download** / **Restore**.

## Restore

```http
POST /api/admin/db/backups/{id}/restore
X-Backlex-Confirm: yes
```

The confirm header is required (same guard as raw SQL writes). Restore:

1. Streams the JSONL from storage.
2. Recreates any missing managed `c_*` physical tables from the `collections`
   metadata in the dump (via the additive schema applier — no-op on adopted
   tables).
3. Re-inserts every row with `INSERT … ON CONFLICT DO NOTHING`, parents before
   children.

Because conflicts are skipped, restore is **safe to run against a live
database**: it can only *add* rows that are missing, never overwrite or delete
existing data. The response reports `{ tableCount, rowCount, skipped }`. A clean
point-in-time rollback (overwriting current state) is a separate, destructive
operation outside this path.

## Per-collection export / import

Move one collection's data in and out — handy for spreadsheets, seeding a new
workspace, or a quick offsite copy.

### Export

```http
GET /api/items/{slug}/export?format=json   # default; a JSON array
GET /api/items/{slug}/export?format=csv    # spreadsheet-friendly CSV
```

Export honors the **exact** read-filter stack a `list` call would — permission
condition + field allow-list, tenant scope, soft-delete, and draft visibility —
so an export never leaks a row you couldn't already read. CSV cells that contain
commas, quotes or newlines are quoted (RFC 4180-style); object/array fields are
serialized as JSON.

### Import

```http
POST /api/items/{slug}/import?format=json   # body: a JSON array (or {data:[…]})
POST /api/items/{slug}/import?format=csv     # body: raw CSV (text/csv)
```

Each row runs through the **normal create path** — validation, the permission
field allow-list, relation checks, revisions, events, and search/vector
indexing all apply. Row-level failures are captured, not fatal: the response is

```json
{ "inserted": 42, "failed": 2, "total": 44, "errors": [{ "row": 7, "error": "…" }] }
```

Notes:

- System/managed columns in the payload (`id`, `created_at`, `updated_at`,
  `tenant_id`, `_status`, …) are **stripped** — every imported row gets a fresh
  id. This is what lets an export round-trip straight back into a collection.
- CSV cells are coerced to the field's type (numbers, booleans, JSON for
  `json`/`relation_many`/`i18n_text`); empty cells are dropped so column
  defaults apply.
- Unknown *user* columns still fail their row (a typo'd header surfaces in
  `errors` rather than being silently dropped).
- Capped at 5000 rows per call — chunk larger loads client-side.

## SDK

```ts
import { createClient } from "@backlex/client";
const backlex = createClient({ url, token });

const csv = await backlex.collection("posts").exportItems("csv");
const summary = await backlex
  .collection("posts")
  .importItems([{ title: "Hello" }, { title: "World" }]); // JSON by default
// → { inserted, failed, total, errors }
```

`importItems` also accepts a raw string plus `"csv"` to upload a spreadsheet
verbatim.
