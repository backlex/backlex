-- Website-analytics dimensions on the product-analytics event stream —
-- SQLite/D1 twin. See the pg migration for why each column exists, why
-- `utm_term` / `utm_content` deliberately stay in `props`, and why `id_scope`
-- is load-bearing rather than metadata.
--
-- Two dialect differences, both forced:
--
-- 1. No `IF NOT EXISTS` — SQLite does not accept it on ADD COLUMN. A replay
--    raises "duplicate column name", which `auto-migrate.ts` tolerates for
--    exactly this statement shape. The indexes below DO take `IF NOT EXISTS`.
--
-- 2. `revenue` is `integer`, not `bigint`. SQLite integers are already 64-bit,
--    so this is the same range as the pg twin's bigint — it is the established
--    pairing in this schema (see `usage_counters.ai_tokens_in`).
--
-- `id_scope` carries the same DEFAULT as the pg twin, which is what backfills
-- every pre-existing row to 'durable'. SQLite applies a DEFAULT to existing
-- rows on ADD COLUMN, so no separate UPDATE is needed.

ALTER TABLE `analytics_events` ADD COLUMN `site_id` text;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `id_scope` text DEFAULT 'durable';--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `device_type` text;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `browser` text;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `os` text;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `utm_source` text;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `utm_medium` text;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `utm_campaign` text;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `revenue` integer;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `currency` text;--> statement-breakpoint
ALTER TABLE `analytics_events` ADD COLUMN `hour` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_events_tenant_hour_idx` ON `analytics_events` (`tenant_id`,`hour`);--> statement-breakpoint
-- Sessionization (phase 4) partitions by `distinct_id` ordered by `ts` and
-- range-filters on `day`. The existing `(tenant_id, distinct_id, ts)` index
-- cannot serve that — the day filter is not a prefix of its ordering, so the
-- planner scans the tenant's entire history. Landed now, while the table is
-- small, rather than with the query that needs it.
CREATE INDEX IF NOT EXISTS `analytics_events_tenant_day_distinct_ts_idx` ON `analytics_events` (`tenant_id`,`day`,`distinct_id`,`ts`);
