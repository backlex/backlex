-- App-plane organizations ("teams") — SQLite/D1 twin of the pg migration.
-- See it for the why. Timestamps are epoch-ms integers here, and the JSON
-- columns are plain `text` (drizzle's `mode: "json"`).

CREATE TABLE IF NOT EXISTS `app_orgs` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `image` text,
  `metadata` text,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `app_orgs_tenant_slug_idx` ON `app_orgs` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_orgs_tenant_idx` ON `app_orgs` (`tenant_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `app_org_members` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `org_id` text NOT NULL,
  `app_user_id` text NOT NULL,
  `role` text DEFAULT 'member' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `app_org_members_pk` ON `app_org_members` (`org_id`,`app_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_org_members_user_idx` ON `app_org_members` (`app_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_org_members_tenant_idx` ON `app_org_members` (`tenant_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `app_org_member_roles` (
  `org_id` text NOT NULL,
  `app_user_id` text NOT NULL,
  `role_id` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `app_org_member_roles_pk` ON `app_org_member_roles` (`org_id`,`app_user_id`,`role_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_org_member_roles_role_idx` ON `app_org_member_roles` (`role_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_org_member_roles_user_idx` ON `app_org_member_roles` (`app_user_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `app_org_invites` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `org_id` text NOT NULL,
  `email` text NOT NULL,
  `role` text DEFAULT 'member' NOT NULL,
  `role_ids` text,
  `token` text NOT NULL,
  `invited_by` text,
  `expires_at` integer NOT NULL,
  `accepted_at` integer,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `app_org_invites_token_idx` ON `app_org_invites` (`token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_org_invites_org_idx` ON `app_org_invites` (`org_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_org_invites_email_idx` ON `app_org_invites` (`email`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_org_invites_tenant_idx` ON `app_org_invites` (`tenant_id`);--> statement-breakpoint

ALTER TABLE `app_sessions` ADD COLUMN `active_org_id` text;
