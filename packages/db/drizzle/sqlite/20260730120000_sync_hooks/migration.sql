-- Synchronous hooks — SQLite/D1 twin of the pg migration. See it for the why.
-- Timestamps are epoch-ms integers, booleans 0/1, JSON columns text.

CREATE TABLE IF NOT EXISTS `sync_hooks` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `name` text NOT NULL,
  `url` text NOT NULL,
  `secret` text,
  `events` text NOT NULL,
  `headers` text,
  `timeout_ms` integer DEFAULT 2000 NOT NULL,
  `on_error` text NOT NULL,
  `can_mutate` integer DEFAULT 0 NOT NULL,
  `priority` integer DEFAULT 0 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `consecutive_failures` integer DEFAULT 0 NOT NULL,
  `last_failure_at` integer,
  `disabled_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sync_hooks_tenant_idx` ON `sync_hooks` (`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sync_hooks_enabled_idx` ON `sync_hooks` (`enabled`);
