-- Resilience wave: the indexes `revisions` never had, and a column that lets a
-- backup say what it could not read.
--
-- `revisions` is the fastest-growing table in the system — one full-row JSON
-- snapshot per update — and until now nothing pruned it and nothing indexed its
-- clock. Compare `activity` (activity_created_idx + activity_tenant_created_idx)
-- and `spans` (spans_created_idx): those prunes are cheap precisely because the
-- cutoff column is indexed. Two indexes, for two different readers:
--
--   * `revisions_created_idx` — the retention sweep's `created_at < cutoff`.
--   * `revisions_item_created_idx` — `recordRevision` looks up the newest
--     revision for one item on EVERY write. The existing `revisions_item_idx`
--     narrows to the item but leaves an unindexed sort over a per-item set that
--     only grows; with `created_at` trailing the same key prefix this becomes an
--     index-only backwards scan with LIMIT 1.
--
-- Deliberately NOT a unique index on (collection, item_id, parent_revision_id).
-- Two concurrent updates can read the same parent and insert siblings, but
-- `parent_revision_id` is written and read NOWHERE, so a forked chain renders
-- identically to a linear one. And a UNIQUE index would be actively harmful
-- here: NULL roots are distinct in both dialects so the fork it is meant to stop
-- survives anyway, and `CREATE UNIQUE INDEX` against a table that already holds
-- siblings fails a check `auto-migrate.ts`'s ALREADY_EXISTS_RE does not tolerate
-- — so it would be retried, and fail, on every cold start, for exactly the
-- customers who have the condition.
--
-- Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run inside a
-- transaction, and a partial failure leaves an INVALID index that a later
-- `IF NOT EXISTS` SKIPS rather than repairs — a worse failure mode under a
-- runner that retries. On a large deployment, pre-apply these CONCURRENTLY on
-- your own schedule; the migration ledger then makes this a tolerated no-op.

CREATE INDEX IF NOT EXISTS "revisions_created_idx"
  ON "revisions" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revisions_item_created_idx"
  ON "revisions" ("tenant_id", "collection", "item_id", "created_at");--> statement-breakpoint

-- Tables named in the dump that did not exist in this database.
--
-- The dump used to swallow every read error, so "this table is absent" and
-- "this table could not be read" were the same silent outcome and the backup
-- still reported `done`. Absence is now recorded here and an actual read failure
-- fails the backup. Stored rather than only returned, because the operator who
-- needs to see it is usually not the one who ran it — most backups are
-- scheduled.
ALTER TABLE "backups" ADD COLUMN "missing_tables" text;
