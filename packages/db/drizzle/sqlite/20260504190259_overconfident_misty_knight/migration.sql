CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`headers` text,
	`secret` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhooks_active_idx` ON `webhooks` (`active`);