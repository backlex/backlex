CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`description` text,
	`layout` text,
	`embed_enabled` integer DEFAULT false NOT NULL,
	`embed_token_hash` text,
	`embed_role_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `dashboards_tenant_idx` ON `dashboards` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dashboards_embed_token_idx` ON `dashboards` (`embed_token_hash`);--> statement-breakpoint
ALTER TABLE `saved_panels` ADD COLUMN `dashboard_id` text;--> statement-breakpoint
CREATE INDEX `saved_panels_dashboard_idx` ON `saved_panels` (`dashboard_id`);
