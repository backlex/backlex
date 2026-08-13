---
title: Schema versions
description: Migration diffing & schema branching — snapshot and branch your schema, diff any two versions into a categorized change list, and apply a target to migrate the live schema with destructive changes gated behind a confirm.
---

Backlex's schema is **dynamic**: a collection is a metadata row plus a physical
table that the additive applier (`applyCollection`) maintains. Schema versions
add GitOps-for-schema on top of that model — snapshot the schema, diff any two
versions, branch off to stage changes, and apply a target to migrate the live
schema. Destructive changes (drop column/table, type change) stay behind an
explicit confirm, and a safety snapshot is captured before every apply so an
apply is always reversible.

This is the productized answer to "what changed between these two schema states,
and is it safe to apply?" — without leaving the dynamic-schema model for
hand-written migration files.

## Concepts

| Concept | What it is |
|---|---|
| **Snapshot** | An immutable, content-hashed capture of the schema-relevant subset of a workspace's collections (`SchemaCollection[]`). A checkpoint you can diff or restore. |
| **Branch** | A named, mutable pointer into snapshot history with a `head` (the working schema) and a `base` (the fork point). Stage changes off to the side, then apply. |
| **Ref** | Where a schema state comes from: `live`, `snapshot:<id>`, or `branch:<id>`. Every diff/apply operates on refs. |
| **Diff** | The categorized change list between two refs — every change tagged **additive**, **destructive**, or **metadata**, with the DDL it would emit per dialect. |
| **Apply** | Reconcile the live schema to a target ref. Additive changes apply freely; destructive ones require `confirmDestructive`. |

### Change severities

The diff splits every change by how it can be applied, mirroring the applier's
additive-only contract:

- **additive** — safe to auto-apply: `CREATE TABLE`, a nullable `ADD COLUMN`,
  `CREATE INDEX`, enabling a `versioned` / `softDelete` / `fts` flag. The applier
  is additive and idempotent, so these never lose data.
- **destructive** — loses data or rows; gated behind `confirmDestructive`:
  `DROP COLUMN`, `DROP TABLE`, a column type change (realised as drop + re-add),
  or a `NOT NULL` add to a possibly-populated table.
- **metadata** — neither DDL nor data risk: display labels, turning a flag *off*
  (the applier never removes the column), interface/validation tweaks. Recorded
  for a faithful restore but free to apply.

Adopted collections never emit DDL — applying changes to an adopted table only
updates Backlex's metadata; the user's table is never touched.

## The GitOps loop

```bash
# 1. Export the current schema (collections metadata as JSON)
bun backlex collections export-schema --out schema.json

# 2. Edit schema.json in git — add a field, a collection, etc.

# 3. Import the authored schema as a snapshot
bun backlex schema import --name "v2" --data @schema.json

# 4. Preview the change against the live schema
bun backlex schema diff --from live --to snapshot:<id>

# 5. Apply it (add --confirm-destructive for drops/type changes)
bun backlex schema apply --target snapshot:<id>
```

A `live → snapshot/branch` apply reconciles collections and columns in safe
order: destructive drops first, then the additive applier (which creates tables,
adds columns, adds indexes, re-adds type-changed columns, enables flags), then
drops metadata rows for collections that vanished from the target.

## Surfaces

Schema versions reach every Backlex surface (mirrors `flows` / `dashboards`):

### REST — `/api/admin/schema` (platform-admin gated)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/snapshots` | list snapshots |
| `POST` | `/snapshots` | capture the live schema (`{ name, note? }`) |
| `POST` | `/snapshots/import` | store an authored schema (`{ name, snapshot, note? }`) |
| `GET` | `/snapshots/:id` | one snapshot (full body) |
| `DELETE` | `/snapshots/:id` | delete (refused if it is a branch head) |
| `GET` | `/branches` | list branches |
| `POST` | `/branches` | fork a branch (`{ name, fromSnapshotId? }`) |
| `GET` | `/branches/:id` | one branch |
| `PATCH` | `/branches/:id/head` | stage a schema on the branch (`{ data?, fromSnapshotId? }`) |
| `DELETE` | `/branches/:id` | delete a branch + its branch-owned snapshots |
| `POST` | `/diff` | diff two refs (`{ from, to }`) |
| `POST` | `/apply` | apply a target ref (`{ target, confirmDestructive? }`) |

### SDK — `client.schema.*`

```ts
const target = await client.schema.import("v2", authoredSchema);
const { data } = await client.schema.diff({ kind: "live" }, { kind: "snapshot", id: target.data.id });
if (!data.diff.hasDestructive) {
  await client.schema.apply({ kind: "snapshot", id: target.data.id });
}
```

`snapshots`, `snapshot`, `capture`, `import`, `deleteSnapshot`, `branches`,
`branch`, `createBranch`, `setBranchHead`, `deleteBranch`, `diff`, `apply`.

### GraphQL

Queries `schemaSnapshots`, `schemaBranches`; mutations `captureSchemaSnapshot`,
`schemaDiff(from, to)`, `schemaApply(target, confirmDestructive)`. Refs are JSON
inputs (`{ kind, id }`); results ride the `JSON` scalar.

### MCP — `schema.*`

`schema.snapshots`, `schema.capture`, `schema.branches`, `schema.diff`,
`schema.apply`. Refs are strings (`live`, `snapshot:<id>`, `branch:<id>`). Lets
an AI agent preview a migration before applying it.

### CLI — `backlex schema`

`snapshots`, `snapshot <id>`, `capture`, `import`, `delete-snapshot`, `branches`,
`branch <id>`, `create-branch`, `set-head`, `delete-branch`, `diff`, `apply`.

### Admin UI

**Data → Schema versions**: a Snapshots/Branches table; "Review & apply" on any
row opens the diff viewer (live → that version) with the categorized change list
and a destructive-changes confirm before applying.

## Safety model

- **Destructive gating** — any diff with a destructive change refuses to apply
  unless `confirmDestructive` is set; the error returns the destructive changes.
- **Auto safety snapshot** — before any apply mutates the schema, the current
  live schema is captured as a `kind: "auto"` snapshot. To roll back, apply it.
- **Adopted tables** — never DDL'd; applying changes only updates metadata.
- **Validation** — imported/authored schemas run the canonical `validateFields`
  (the same guard the create endpoint uses) before they can be applied.

## Data model

Two dual-dialect tables (`packages/db/src/{pg,sqlite}/schema.ts`):

- `schema_snapshots` — `snapshot` (JSON), `hash` (sha256 of the canonical
  snapshot), `kind` (`manual` | `branch` | `auto`), `parent_snapshot_id`,
  `branch_id`, `created_by`.
- `schema_branches` — `head_snapshot_id`, `base_snapshot_id`, unique
  `(tenant_id, name)`.

The pure diff engine lives in `packages/db/src/schema-diff.ts` (`diffSchema`); the
orchestration in `apps/web/src/server/services/schema-versions.ts`.

## What an apply saves before it destroys anything

A destructive apply takes **two** safety copies, and they cover different things:

- `safetySnapshotId` — the live **schema** before the apply. Records what the
  columns were, not what was in them.
- `dataSnapshotIds` — a `pre-drop` backup per destructive change, holding the
  rows that change is about to destroy. `field.drop` and `field.type` capture
  `(id, <column>)` for the rows where the column holds a value; `collection.drop`
  captures the whole table.

Recovery is the ordinary restore path: re-add the field (or re-create the
collection), then restore the snapshot with `mode=overwrite` and `onlyTables` set
to that one table. An additive restore will not do it — the rows still exist, so
every one is skipped and the column comes back empty. See
`docs/backup-restore.md`.

Data snapshots require a storage adapter. Without one the apply still runs and
`dataSnapshotIds` comes back empty, which is the honest answer rather than a
safety net that silently is not there.
