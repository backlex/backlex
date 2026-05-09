CREATE TABLE `activity` (
	`id` text PRIMARY KEY,
	`user_id` text,
	`action` text NOT NULL,
	`collection` text NOT NULL,
	`item_id` text,
	`ip` text,
	`user_agent` text,
	`payload` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_collection_item_idx` ON `activity` (`collection`,`item_id`);--> statement-breakpoint
CREATE INDEX `activity_user_idx` ON `activity` (`user_id`);--> statement-breakpoint
CREATE INDEX `activity_created_idx` ON `activity` (`created_at`);