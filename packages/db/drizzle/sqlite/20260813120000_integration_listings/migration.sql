-- Product listings — SQLite/D1 twin. See the pg migration for why the category
-- mapping is a table rather than a blob on the sync row, and why the batch
-- sweep runs independently of any sync's schedule.

ALTER TABLE `integration_syncs` ADD COLUMN `category_field` text;--> statement-breakpoint
ALTER TABLE `integration_syncs` ADD COLUMN `outputs_mapping` text DEFAULT '{}' NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `integration_listing_maps` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `sync_id` text NOT NULL,
  `local_value` text NOT NULL,
  `category_id` text NOT NULL,
  `attributes` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `integration_listing_maps_value_idx`
  ON `integration_listing_maps` (`sync_id`, `local_value`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_listing_maps_tenant_idx`
  ON `integration_listing_maps` (`tenant_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `integration_listing_batches` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `sync_id` text NOT NULL,
  `integration_id` text NOT NULL,
  `batch_id` text NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `sent` text DEFAULT '{}' NOT NULL,
  `pending_count` integer DEFAULT 0 NOT NULL,
  `error` text,
  `created_at` integer NOT NULL,
  `resolved_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `integration_listing_batches_ticket_idx`
  ON `integration_listing_batches` (`sync_id`, `batch_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_listing_batches_open_idx`
  ON `integration_listing_batches` (`status`, `created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_listing_batches_tenant_idx`
  ON `integration_listing_batches` (`tenant_id`);
