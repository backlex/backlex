CREATE TABLE `email_config` (
	`tenant_id` text PRIMARY KEY,
	`provider` text DEFAULT 'inherit' NOT NULL,
	`from_address` text,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
