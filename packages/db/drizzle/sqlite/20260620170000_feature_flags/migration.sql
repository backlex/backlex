CREATE TABLE `feature_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`key` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`value` text,
	`rules` text,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `feature_flags_unique_idx` ON `feature_flags` (`tenant_id`,`key`);--> statement-breakpoint
CREATE INDEX `feature_flags_tenant_idx` ON `feature_flags` (`tenant_id`);
