-- Scheduled pulls from a source integration into a collection. SQLite/D1 twin
-- of the pg migration; timestamps are epoch-ms integers and booleans 0/1.
CREATE TABLE IF NOT EXISTS `integration_syncs` (
  `id` text PRIMARY KEY NOT NULL,
  `integration_id` text NOT NULL,
  `tenant_id` text NOT NULL,
  `collection` text NOT NULL,
  `settings` text DEFAULT '{}' NOT NULL,
  `mapping` text DEFAULT '{}' NOT NULL,
  `interval_minutes` integer DEFAULT 60 NOT NULL,
  `enabled` integer DEFAULT true NOT NULL,
  `cursor` text,
  `last_run_at` integer,
  `last_row_count` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `consecutive_failures` integer DEFAULT 0 NOT NULL,
  `disabled_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_syncs_tenant_idx` ON `integration_syncs` (`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_syncs_integration_idx` ON `integration_syncs` (`integration_id`);--> statement-breakpoint
-- The scheduler sweeps "enabled and due", so it reads both columns together.
CREATE INDEX IF NOT EXISTS `integration_syncs_due_idx` ON `integration_syncs` (`enabled`,`last_run_at`);
