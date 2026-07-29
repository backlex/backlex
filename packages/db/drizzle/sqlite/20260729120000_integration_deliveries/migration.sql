-- Durable integration delivery — SQLite/D1 twin of the pg migration. See it for
-- the why. Timestamps are epoch-ms integers here, and SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so the three column adds are plain (the runner
-- applies each migration exactly once).

ALTER TABLE `integrations` ADD COLUMN `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `integrations` ADD COLUMN `last_failure_at` integer;--> statement-breakpoint
ALTER TABLE `integrations` ADD COLUMN `disabled_reason` text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `integration_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `integration_id` text NOT NULL,
  `tenant_id` text,
  `event` text NOT NULL,
  `status` integer NOT NULL,
  `ms` integer NOT NULL,
  `error` text,
  `attempts` integer DEFAULT 1 NOT NULL,
  `delivered_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_deliveries_integration_idx`
  ON `integration_deliveries` (`integration_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_deliveries_tenant_idx`
  ON `integration_deliveries` (`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_deliveries_at_idx`
  ON `integration_deliveries` (`delivered_at`);
