CREATE TABLE `flows` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`operations` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `flows_active_idx` ON `flows` (`active`);