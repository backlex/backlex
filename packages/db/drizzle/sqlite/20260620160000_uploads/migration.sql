CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`key` text NOT NULL,
	`physical_key` text NOT NULL,
	`storage_upload_id` text,
	`size` integer NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`parts` text DEFAULT '[]' NOT NULL,
	`content_type` text,
	`folder_id` text,
	`owner_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `uploads_tenant_idx` ON `uploads` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `uploads_expires_idx` ON `uploads` (`expires_at`);--> statement-breakpoint
CREATE INDEX `uploads_status_idx` ON `uploads` (`status`);
