-- CDC sinks — SQLite/D1 twin. See the pg migration for why the cursor advances
-- only after a delivery is acknowledged.

CREATE TABLE IF NOT EXISTS `cdc_sinks` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `collection` text NOT NULL,
  `destination` text NOT NULL,
  `config` text NOT NULL,
  `shape` text,
  `fields` text,
  `batch_size` integer DEFAULT 100 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `cursor` text,
  `last_run_at` integer,
  `last_error` text,
  `consecutive_failures` integer DEFAULT 0 NOT NULL,
  `disabled_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cdc_sinks_tenant_idx` ON `cdc_sinks` (`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cdc_sinks_enabled_idx` ON `cdc_sinks` (`enabled`);
