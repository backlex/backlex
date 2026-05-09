ALTER TABLE `collections` ADD `singular` text;--> statement-breakpoint
ALTER TABLE `collections` ADD `plural` text;--> statement-breakpoint
ALTER TABLE `collections` ADD `note` text;--> statement-breakpoint
ALTER TABLE `collections` ADD `display_template` text;--> statement-breakpoint
DROP INDEX IF EXISTS `records_collection_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `records_owner_idx`;--> statement-breakpoint
DROP TABLE `records`;