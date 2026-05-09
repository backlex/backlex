CREATE TABLE `comments` (
	`id` text PRIMARY KEY,
	`collection` text NOT NULL,
	`item_id` text NOT NULL,
	`user_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY,
	`webhook_id` text NOT NULL,
	`event` text NOT NULL,
	`status` integer NOT NULL,
	`ms` integer NOT NULL,
	`response_body` text,
	`error` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`delivered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comments_item_idx` ON `comments` (`collection`,`item_id`);--> statement-breakpoint
CREATE INDEX `comments_user_idx` ON `comments` (`user_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_hook_idx` ON `webhook_deliveries` (`webhook_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_at_idx` ON `webhook_deliveries` (`delivered_at`);