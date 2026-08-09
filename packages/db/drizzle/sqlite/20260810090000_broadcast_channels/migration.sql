-- Broadcast channels — SQLite/D1 twin. See the pg migration for the why.
-- Booleans are 0/1, timestamps epoch-ms integers, JSON columns are text.

CREATE TABLE IF NOT EXISTS `broadcast_channels` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `pattern` text NOT NULL,
  `subscribe` text NOT NULL,
  `publish` text NOT NULL,
  `presence` integer DEFAULT 0 NOT NULL,
  `replay` integer DEFAULT 0 NOT NULL,
  `retention_hours` integer DEFAULT 24 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `broadcast_channels_pattern_idx`
  ON `broadcast_channels` (`tenant_id`,`pattern`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `broadcast_channels_tenant_idx`
  ON `broadcast_channels` (`tenant_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `broadcast_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `channel` text NOT NULL,
  `day` integer NOT NULL,
  `event` text NOT NULL,
  `payload` text,
  `sender_id` text,
  `sender_name` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `broadcast_messages_read_idx`
  ON `broadcast_messages` (`tenant_id`,`channel`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `broadcast_messages_day_idx`
  ON `broadcast_messages` (`day`);
