CREATE TABLE `notifications` (
	`id` text PRIMARY KEY,
	`user_id` text,
	`title` text NOT NULL,
	`body` text,
	`url` text,
	`flow_id` text,
	`read_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`user_id`,`read_at`);