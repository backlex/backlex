-- The grouping key for page reports — SQLite/D1 twin. See the pg migration for
-- why `path` keeps its query string and why the grouping key is materialized
-- rather than computed.
--
-- SQLite has no `split_part`, so the backfill uses `instr` + `substr`: take
-- everything before the first `?`, or the whole path when there is none.
--
-- No `IF NOT EXISTS` on ADD COLUMN (SQLite does not accept it); a replay raises
-- "duplicate column name", which `auto-migrate.ts` tolerates. The UPDATE is
-- guarded on `path_base IS NULL`, so it is a no-op on a second run.

ALTER TABLE `analytics_events` ADD COLUMN `path_base` text;--> statement-breakpoint
UPDATE `analytics_events` SET `path_base` = CASE WHEN instr(`path`, '?') > 0 THEN substr(`path`, 1, instr(`path`, '?') - 1) ELSE `path` END WHERE `path` IS NOT NULL AND `path_base` IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_events_tenant_path_base_idx` ON `analytics_events` (`tenant_id`,`path_base`);
