-- Auth hooks — SQLite/D1 twin of the pg migration. See it for the why: why the
-- hooks are workspace-plane only, why there is one hook per (workspace, event),
-- and why `on_error` has no default. Timestamps are epoch-ms integers, booleans
-- are 0/1, and JSON columns are text.

CREATE TABLE IF NOT EXISTS `auth_hooks` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `event` text NOT NULL,
  `target_type` text NOT NULL,
  `url` text,
  `function_name` text,
  `secret` text,
  `headers` text,
  `timeout_ms` integer DEFAULT 2000 NOT NULL,
  `on_error` text NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `consecutive_failures` integer DEFAULT 0 NOT NULL,
  `last_failure_at` integer,
  `disabled_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `auth_hooks_tenant_event_idx`
  ON `auth_hooks` (`tenant_id`,`event`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_hooks_tenant_idx`
  ON `auth_hooks` (`tenant_id`);
