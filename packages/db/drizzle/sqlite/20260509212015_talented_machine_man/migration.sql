CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY,
	`tenant_id` text,
	`key` text NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_config` (
	`tenant_id` text PRIMARY KEY,
	`providers` text DEFAULT '{}' NOT NULL,
	`policy` text DEFAULT '{}' NOT NULL,
	`session_lifetime` text DEFAULT '30d' NOT NULL,
	`redirect_urls` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY,
	`tenant_id` text,
	`kind` text DEFAULT 'manual' NOT NULL,
	`label` text,
	`storage_key` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`table_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY,
	`tenant_id` text,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`from_address` text,
	`body_html` text NOT NULL,
	`body_text` text,
	`variables` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `i18n_strings` (
	`id` text PRIMARY KEY,
	`tenant_id` text,
	`key` text NOT NULL,
	`locale` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_panels` (
	`id` text PRIMARY KEY,
	`tenant_id` text,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'sql' NOT NULL,
	`sql` text,
	`viz` text DEFAULT 'sparkline' NOT NULL,
	`config` text,
	`layout` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenant_members` (
	`id` text PRIMARY KEY,
	`tenant_id` text NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`invited_by` text,
	`invited_at` integer,
	`joined_at` integer,
	`invite_token` text,
	`invite_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_tenant_members_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`project` text DEFAULT 'default' NOT NULL,
	`branch` text DEFAULT 'main' NOT NULL,
	`env` text DEFAULT 'development' NOT NULL,
	`mark` text,
	`color` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `activity` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `collections` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `collections` ADD `tenant_scoped` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `files` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `files` ADD `acl` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE `flows` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `functions` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `revisions` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `active_tenant_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `suspended_at` integer;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `tenant_id` text;--> statement-breakpoint
DROP INDEX IF EXISTS `functions_name_idx`;--> statement-breakpoint
CREATE INDEX `activity_tenant_idx` ON `activity` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_settings_unique_idx` ON `app_settings` (`tenant_id`,`key`);--> statement-breakpoint
CREATE INDEX `backups_tenant_idx` ON `backups` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `backups_created_idx` ON `backups` (`created_at`);--> statement-breakpoint
CREATE INDEX `comments_tenant_idx` ON `comments` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_templates_tenant_key_idx` ON `email_templates` (`tenant_id`,`key`);--> statement-breakpoint
CREATE INDEX `files_tenant_idx` ON `files` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `flows_tenant_idx` ON `flows` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `functions_tenant_name_idx` ON `functions` (`tenant_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `i18n_strings_unique_idx` ON `i18n_strings` (`tenant_id`,`key`,`locale`);--> statement-breakpoint
CREATE INDEX `i18n_strings_locale_idx` ON `i18n_strings` (`locale`);--> statement-breakpoint
CREATE INDEX `notifications_tenant_idx` ON `notifications` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `revisions_tenant_idx` ON `revisions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `saved_panels_tenant_idx` ON `saved_panels` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_members_tenant_email_idx` ON `tenant_members` (`tenant_id`,`email`);--> statement-breakpoint
CREATE INDEX `tenant_members_user_idx` ON `tenant_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `tenant_members_invite_token_idx` ON `tenant_members` (`invite_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_idx` ON `tenants` (`slug`);--> statement-breakpoint
CREATE INDEX `webhooks_tenant_idx` ON `webhooks` (`tenant_id`);