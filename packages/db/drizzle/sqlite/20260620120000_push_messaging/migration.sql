CREATE TABLE `device_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`token` text NOT NULL,
	`keys` text,
	`device_name` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `device_tokens_unique_idx` ON `device_tokens` (`user_id`,`platform`,`token`);--> statement-breakpoint
CREATE INDEX `device_tokens_user_idx` ON `device_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `device_tokens_tenant_idx` ON `device_tokens` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `push_config` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'inherit' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `push_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`url` text,
	`variables` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `push_templates_tenant_key_idx` ON `push_templates` (`tenant_id`,`key`);
