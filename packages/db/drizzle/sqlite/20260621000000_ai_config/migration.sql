CREATE TABLE IF NOT EXISTS `ai_config` (
	`tenant_id` text PRIMARY KEY,
	`provider` text DEFAULT 'inherit' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
