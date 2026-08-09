-- S3-compatible endpoint credentials — SQLite/D1 twin. See the pg migration for
-- why `secret_key` is an encrypted secret rather than a digest.

CREATE TABLE IF NOT EXISTS `s3_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `access_key_id` text NOT NULL,
  `secret_key` text NOT NULL,
  `prefix` text,
  `read_only` integer DEFAULT 0 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `expires_at` integer,
  `last_used_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `s3_credentials_akid_idx`
  ON `s3_credentials` (`access_key_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `s3_credentials_tenant_idx`
  ON `s3_credentials` (`tenant_id`);
