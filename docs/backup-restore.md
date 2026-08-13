---
title: Backup, restore & export
description: Logical JSONL backups (manual + scheduled), additive or overwrite restore, pre-drop safety copies for destructive schema changes, plus per-collection CSV/JSON export-import.
---

Backlex ships a **logical** backup system: every backup is a portable JSONL
dump of your data, written through the storage adapter (R2/S3/filesystem). It
works identically on every runtime and both dialects — unlike a
Cloudflare-D1 point-in-time snapshot, a logical dump moves cleanly between
Postgres and SQLite/D1.

Three things live here:

1. **Backups** — manual or scheduled JSONL dumps of every system table + your
   `c_*` collection tables.
2. **Restore** — write a dump's rows back. **Additive** by default (missing rows
   come back, existing rows are untouched); `mode=overwrite` also restates rows
   that still exist, which is what undoes a bad write.
3. **Pre-drop snapshots** — the data a destructive schema change is about to
   destroy, captured automatically so the change is recoverable.
4. **Per-collection export/import** — pull one collection's rows out as JSON or
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
per row — `{"table":"<name>","row":{…}}`, a format a restore *could* process
line by line. It does not today: both the dump and the restore hold the whole
document in memory, which is what `BACKUP_MAX_ROWS` below bounds.

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
{ "schedule": "daily", "retain": 7, "retainDays": 30 }
# schedule: off | daily | weekly
# retain: keep this many newest auto backups (1–365)
# retainDays: ALSO prune autos older than N days (1–3650); null = count-only
GET /api/admin/db/backups/config
```

The cron tick runs a throttled sweep (`maybeRunScheduledBackups`) that, for
each workspace with a non-`off` schedule, checks the age of the most recent
`auto` backup against the interval, runs one if it's due, then prunes `auto`
backups beyond the newest `retain` — and, when `retainDays` is set, any older
than that many days regardless of count (deleting their storage objects too).
**Manual backups are never pruned.**

In the admin, this is the **Database → Backups** tab: the schedule selector
(Off / Daily / Weekly), the retention input, **Back up now**, and per-row
**Download** / **Restore**.

### Failure alerting

A backup that fails (manual or scheduled) marks its row `failed` with the error,
writes a `backup.failed` audit row, **and** publishes `system:backup.failed` on
the event channel (payload: `backupId`, `tenantId`, `label`, `storageKey`,
`error`). Subscribe an outbound webhook to `system:backup.failed` (or `system:*`)
to alert your team — an unattended scheduled backup that silently stops running
is exactly the kind of failure you want pushed, not polled.

### What counts as a failure

A table that **exists and cannot be read** fails the whole backup. It used to be
swallowed: the rows silently vanished from the dump and the run still reported
`done`, which is the worst possible outcome for the one artifact recovery
depends on.

A table that is **absent** is tolerated — a partial migration or a table dropped
outside backlex — but it is now recorded rather than inferred. Absent tables are
listed in `missing_tables` on the backup row and returned as `missingTables`.

Two bounds sit on top of that:

- **`BACKUP_MAX_ROWS`** (default `500000`). The dump is assembled in memory, so
  past some size a large workspace does not produce a bad backup — it OOMs the
  isolate, and an OOM never reaches the failure handler, leaving the row stuck at
  `running` forever. The budget converts that into a `failed` row an operator can
  see. Raise it where the runtime has the headroom.
- Any row left at `running` for over an hour is flipped to `failed` by the
  scheduled sweep. Nothing else can close those out — the process that owned them
  is gone.

Neither the dump nor the restore streams today; both hold the whole document in
memory. That is what `BACKUP_MAX_ROWS` bounds, and it is the reason the row
budget exists rather than a note telling you to be careful.

## Restore

```http
POST /api/admin/db/backups/{id}/restore
X-Backlex-Confirm: yes
```

The confirm header is required in **either** mode (same guard as raw SQL
writes). Restore:

1. Reads the JSONL from storage.
2. Recreates any missing managed `c_*` physical tables from the `collections`
   metadata in the dump (via the additive schema applier — no-op on adopted
   tables).
3. Writes every row, parents before children.

The response reports `{ tableCount, rowCount, skipped, overwritten,
keptAdditive }`.

### Two modes

| `?mode=` | What happens to a row that still exists | Use it for |
|---|---|---|
| `additive` *(default)* | Nothing — `INSERT … ON CONFLICT DO NOTHING` | Bringing back deleted rows against a live database. Cannot destroy anything. |
| `overwrite` | Restated to its backup-era values | Undoing a bad write: a wrong bulk update, a dropped column's data, a botched migration. **Can destroy current data.** |

`overwrite` is the only path that can undo an *edit*. Additive restore skips
every row that still exists, which is why re-adding a dropped column and running
a plain restore brings the column back **empty**.

Narrow it with `?onlyTables=a,b`. Always do this for a targeted recovery —
otherwise a single collection's rollback also drags `app_settings`, `auth_config`
and `api_keys` back to backup time.

```http
POST /api/admin/db/backups/{id}/restore?mode=overwrite&onlyTables=c_ab12cd34ef56_orders
X-Backlex-Confirm: yes
```

Two things worth knowing about `overwrite`:

- It is **UPDATE-then-INSERT**, not `ON CONFLICT (id) DO UPDATE`. A pre-drop
  snapshot holds only `(id, <column>)`, and inserting a partial row trips the
  table's `NOT NULL` constraints before any conflict clause is reached. The
  UPDATE names only the columns present; the INSERT after it is the "row was
  deleted" arm and is allowed to fail on its own.
- Tables with no single-column `id` cannot name a conflict target and stay
  additive. They are listed in `keptAdditive` rather than silently downgraded —
  `user_roles` is the standing example, keyed `(user_id, role_id)`.
- **Two things are never restated, and both are about reach rather than keys.**
  A `users` row is a global identity — the same person can belong to several
  workspaces, so overwriting one from a single workspace's backup would be
  visible in all of them. And an **instance-global system row** (`tenant_id IS
  NULL`) is skipped too: every workspace's dump deliberately carries those (the
  default email templates, global `app_settings`, instance-wide `api_keys`), and
  restating them would revert instance configuration from an operation scoped to
  one workspace. Both appear in `keptAdditive`. Rows in your own dynamic `c_*`
  tables are unaffected, which is what makes pre-drop recovery work.

Every restore writes a `backup.restored` audit row recording the mode, the
tables, and the counts.

There is still no point-in-time rollback in the sense of "return the database to
exactly 14:03" — `overwrite` restates the rows a backup contains and does not
delete rows created since.

### Workspace scoping

Both directions are scoped to one workspace, and the scoping is derived from the
schema rather than probed at runtime:

- **Dump.** Most system tables filter on their own `tenant_id`. Four don't have
  one, so they're scoped through the relation that does — `users` via
  `tenant_members`, `user_roles` and `permissions` via `roles.tenant_id`, and
  `tenants` by its own id. Globally-seeded rows (`tenant_id IS NULL`, e.g. the
  default email templates) are included in every workspace's backup. Dynamic
  `c_*` tables filter on `tenant_id` when the collection is tenant-scoped and are
  dumped whole when it isn't.
- **Restore.** Every row is checked against the target workspace before it is
  written, not just the `collections` metadata: rows carrying a foreign
  `tenant_id` are counted in `skipped` and never inserted, and `user_roles` /
  `permissions` are accepted only when they point at a role in the target
  workspace.

A backup taken with no workspace (`tenantId: null` — the instance-wide scheduled
backup) contains everything and restores everything, which is the intended
disaster-recovery path.

## Destructive schema changes

Dropping a field or deleting a collection is DDL — it cannot be rolled back. The
**data** it destroys now can be.

Before either operation runs, backlex captures a `pre-drop` backup: for a field
drop, `(id, <column>)` for every row where the column holds a value; for a
collection delete, the whole table. It uses the same JSONL format and the same
`backups` row as any other backup, so recovery is the ordinary restore above.

```http
# 1. What would this destroy? (changes nothing)
DELETE /api/collections/orders/fields/notes?dryRun=1
→ { "dryRun": true, "rows": 4210, "nonNull": 3987, "table": "c_ab12…_orders" }

# 2. Confirm — the response hands back the snapshot id
DELETE /api/collections/orders/fields/notes
X-Backlex-Confirm: yes
→ { "ok": true, "nonNull": 3987, "snapshotId": "b1f0…" }

# 3. Re-add the field, then put the values back
POST /api/admin/db/backups/b1f0…/restore?mode=overwrite&onlyTables=c_ab12…_orders
X-Backlex-Confirm: yes
```

Step 3 must be `mode=overwrite`. The rows still exist, so an additive restore
skips every one of them and the column comes back empty.

### The confirm gate is conditional

`X-Backlex-Confirm: yes` is required **only when the operation would actually
destroy data** — a column where some row holds a value, or a collection whose
table holds rows. Dropping an empty column or deleting an empty collection works
exactly as it always did, with no header.

That is deliberate: CI, template automation and dev scripts drop scaffolding
columns constantly, and an unconditional gate would break all of them for no
safety gained. A refusal names the count, so it is actionable rather than a wall.

### It is not route-local

`POST /api/admin/schema/apply` reaches the same `dropField` / `dropCollection`
through the schema-versions diff engine, and that endpoint is reachable from
REST, the SDK, the CLI, MCP and GraphQL. It captures the same snapshots and
returns their ids as `dataSnapshotIds`, alongside the `safetySnapshotId` it
already returned.

Note the difference between the two: `safetySnapshotId` is a **schema** snapshot
— it records what the columns *were*, not what was *in* them. On its own it makes
an apply reversible in shape and irreversible in content.

### Retention

`pre-drop` backups are **never** pruned by the scheduled sweep, which only
touches `kind = "auto"`. An artifact created because something was destroyed
should not expire on the backup schedule's clock. The trade-off is that they
accumulate — delete them from Database → Backups when you no longer need them.

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
  `json`/`relation_many`); empty cells are dropped so column
  defaults apply.
- Unknown *user* columns still fail their row (a typo'd header surfaces in
  `errors` rather than being silently dropped).
- Capped at 5000 rows per call — chunk larger loads client-side.

## SDK

```ts
import { createClient } from "backlex";
const backlex = createClient({ url, token });

const csv = await backlex.collection("posts").exportItems("csv");
const summary = await backlex
  .collection("posts")
  .importItems([{ title: "Hello" }, { title: "World" }]); // JSON by default
// → { inserted, failed, total, errors }
```

`importItems` also accepts a raw string plus `"csv"` to upload a spreadsheet
verbatim.

Backups themselves are on `client.backups`:

```ts
const { data: b } = await backlex.backups.run({ label: "before-migration" });
await backlex.backups.list(); // tracking rows, newest first
await backlex.backups.restore(b.id); // additive; the SDK sends the confirm header
// Undo a bad write, narrowed to one table:
await backlex.backups.restore(b.id, { mode: "overwrite", onlyTables: ["c_ab12cd34ef56_orders"] });
await backlex.backups.setConfig({ schedule: "daily", retain: 14 });
```

## Other surfaces

Backup/restore has full multi-surface parity (gate:
`apps/web/tests/backup-surfaces.test.ts`):

- **GraphQL** — `backups` / `backupConfig` queries; `runBackup(label)`,
  `restoreBackup(id, confirm: true, overwrite, onlyTables)`,
  `setBackupConfig(data)` mutations. `confirm: true` mirrors REST's
  `X-Backlex-Confirm: yes` header; `overwrite: true` mirrors `?mode=overwrite`.
- **MCP** — `backups.list`, `backups.run`, `backups.restore` (requires
  `confirm: true`), `backups.get_config`, `backups.set_config`.
- **CLI** — `backlex backup <list|now|download|restore|config>` (see
  `docs/sdk-and-cli.md`).
