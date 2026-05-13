CREATE TABLE `workspace_config` (
	`tenant_id` text PRIMARY KEY,
	`workspace_name` text,
	`description` text,
	`logo_file_key` text,
	`favicon_file_key` text,
	`primary_color` text,
	`default_theme` text,
	`updated_at` integer NOT NULL
);
