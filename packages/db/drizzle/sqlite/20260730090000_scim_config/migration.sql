-- SCIM 2.0 provisioning endpoint — SQLite/D1 twin of the pg migration. See it
-- for the why. Timestamps are epoch-ms integers, booleans 0/1.

CREATE TABLE IF NOT EXISTS `scim_config` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `token_hash` text NOT NULL,
  `token_prefix` text NOT NULL,
  `default_role_id` text REFERENCES `roles`(`id`) ON DELETE SET NULL,
  `last_request_at` integer,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `scim_config_tenant_idx` ON `scim_config` (`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scim_config_token_idx` ON `scim_config` (`token_hash`);
