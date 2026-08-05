-- KPI alerts — SQLite/D1 twin of the pg migration, where the reasoning is
-- written out in full.
--
-- The short version: a KPI nobody opens is a question nobody asked, and the
-- figures that matter most are exactly those. `alert_firing` is what makes the
-- alert fire on the TRANSITION into breach rather than every tick — re-notifying
-- once a minute for as long as the condition holds trains people to ignore the
-- channel, and an ignored alert is worse than none because it looks like cover.
ALTER TABLE `kpis` ADD COLUMN `alert_operator` text;
--> statement-breakpoint
ALTER TABLE `kpis` ADD COLUMN `alert_value` real;
--> statement-breakpoint
ALTER TABLE `kpis` ADD COLUMN `alert_firing` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `kpis` ADD COLUMN `alert_last_fired_at` integer;
