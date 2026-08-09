-- Captcha configuration and audited impersonation — SQLite/D1 twin.
-- See the pg migration for the why.

ALTER TABLE `auth_config` ADD COLUMN `captcha` text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `impersonations` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `actor_user_id` text NOT NULL,
  `actor_email` text,
  `subject_user_id` text NOT NULL,
  `subject_email` text,
  `reason` text NOT NULL,
  `read_only` integer DEFAULT 1 NOT NULL,
  `expires_at` integer NOT NULL,
  `ended_at` integer,
  `ended_by` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `impersonations_tenant_idx`
  ON `impersonations` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `impersonations_subject_idx`
  ON `impersonations` (`subject_user_id`);--> statement-breakpoint

-- The operator behind an impersonated request — see the pg migration.
ALTER TABLE `activity` ADD COLUMN `impersonated_by` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `activity_impersonated_idx`
  ON `activity` (`impersonated_by`);
