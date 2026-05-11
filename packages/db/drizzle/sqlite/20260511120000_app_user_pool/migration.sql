-- Workspace end-user auth pool ("auth as a service"). Mirrors the PG migration:
-- adds app_users / app_sessions / app_accounts / app_verifications, a per-tenant
-- identity pool for the end-users of apps built on a workspace (separate from
-- the control-plane `users` table the admin app uses). Additive only.

CREATE TABLE `app_users` (
	`id` text PRIMARY KEY,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`name` text,
	`image` text,
	`status` text DEFAULT 'active' NOT NULL,
	`suspended_at` integer,
	`is_anonymous` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_app_users_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_sessions` (
	`id` text PRIMARY KEY,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_app_sessions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_app_sessions_user_id_app_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_accounts` (
	`id` text PRIMARY KEY,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`password` text,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_app_accounts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_app_accounts_user_id_app_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_verifications` (
	`id` text PRIMARY KEY,
	`tenant_id` text NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_app_verifications_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_users_tenant_email_idx` ON `app_users` (`tenant_id`,`email`);--> statement-breakpoint
CREATE INDEX `app_users_tenant_idx` ON `app_users` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_sessions_token_idx` ON `app_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `app_sessions_user_idx` ON `app_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `app_sessions_tenant_idx` ON `app_sessions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `app_accounts_user_idx` ON `app_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `app_accounts_tenant_idx` ON `app_accounts` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `app_verifications_tenant_idx` ON `app_verifications` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `app_verifications_identifier_idx` ON `app_verifications` (`identifier`);
