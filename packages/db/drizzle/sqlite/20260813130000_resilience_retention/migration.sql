-- Resilience wave — SQLite/D1 twin. See the pg migration for why `revisions`
-- gets two indexes rather than one, why a UNIQUE index on the revision chain
-- would be actively harmful, and what `missing_tables` records.
--
-- Both statements are additive and `IF NOT EXISTS` / `ADD COLUMN`, so a replay
-- lands in `auto-migrate.ts`'s tolerated set rather than failing the boot.

CREATE INDEX IF NOT EXISTS `revisions_created_idx`
  ON `revisions` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `revisions_item_created_idx`
  ON `revisions` (`tenant_id`, `collection`, `item_id`, `created_at`);--> statement-breakpoint

ALTER TABLE `backups` ADD COLUMN `missing_tables` text;
