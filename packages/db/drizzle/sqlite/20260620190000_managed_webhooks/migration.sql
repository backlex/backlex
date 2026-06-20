ALTER TABLE `webhooks` ADD COLUMN `consecutive_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `webhooks` ADD COLUMN `last_failure_at` integer;
--> statement-breakpoint
ALTER TABLE `webhooks` ADD COLUMN `disabled_reason` text;
