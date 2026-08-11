-- Inbound webhooks — SQLite/D1 twin. See the pg migration for why these columns
-- ride on `integration_syncs` instead of a table of their own, and why the
-- deliveries table is both the log and the replay guard.

ALTER TABLE `integration_syncs` ADD COLUMN `webhook_token` text;--> statement-breakpoint
ALTER TABLE `integration_syncs` ADD COLUMN `webhook_secret` text;--> statement-breakpoint
ALTER TABLE `integration_syncs` ADD COLUMN `webhook_events` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_syncs` ADD COLUMN `webhook_external_id` text;--> statement-breakpoint
ALTER TABLE `integration_syncs` ADD COLUMN `match_field` text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `integration_syncs_webhook_token_idx`
  ON `integration_syncs` (`webhook_token`) WHERE `webhook_token` IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `integration_webhook_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `sync_id` text NOT NULL,
  `integration_id` text NOT NULL,
  `event` text NOT NULL,
  `delivery_id` text NOT NULL,
  `status` text NOT NULL,
  `rows_written` integer DEFAULT 0 NOT NULL,
  `error` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `integration_webhook_deliveries_once_idx`
  ON `integration_webhook_deliveries` (`sync_id`, `delivery_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_webhook_deliveries_tenant_idx`
  ON `integration_webhook_deliveries` (`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_webhook_deliveries_sync_idx`
  ON `integration_webhook_deliveries` (`sync_id`, `created_at`);
