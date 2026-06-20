CREATE TABLE `phone_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`user_id` text NOT NULL,
	`phone_number` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `phone_numbers_unique_idx` ON `phone_numbers` (`user_id`,`phone_number`);--> statement-breakpoint
CREATE INDEX `phone_numbers_user_idx` ON `phone_numbers` (`user_id`);--> statement-breakpoint
CREATE INDEX `phone_numbers_tenant_idx` ON `phone_numbers` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `sms_config` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'inherit' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
