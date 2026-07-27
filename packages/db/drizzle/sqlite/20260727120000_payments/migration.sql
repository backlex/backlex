-- Payments integration — SQLite/D1 twin of the pg migration. See it for the why.
-- Timestamps are epoch-ms integers here.

CREATE TABLE IF NOT EXISTS `payment_providers` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `provider` text NOT NULL,
  `config` text DEFAULT '{}' NOT NULL,
  `status` text DEFAULT 'connected' NOT NULL,
  `webhook_token` text NOT NULL,
  `sync_cursor` text,
  `last_event_at` integer,
  `last_sync_at` integer,
  `last_sync_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `payment_providers_tenant_provider_idx`
  ON `payment_providers` (`tenant_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `payment_providers_token_idx`
  ON `payment_providers` (`webhook_token`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `payment_events` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `provider_id` text NOT NULL,
  `external_id` text NOT NULL,
  `type` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'received' NOT NULL,
  `record_count` integer DEFAULT 0 NOT NULL,
  `error` text,
  `payload` text,
  `created_at` integer NOT NULL,
  `processed_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `payment_events_dedupe_idx`
  ON `payment_events` (`provider_id`,`external_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `payment_events_tenant_created_idx`
  ON `payment_events` (`tenant_id`,`created_at`);
