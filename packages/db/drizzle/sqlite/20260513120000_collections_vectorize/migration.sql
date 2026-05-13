ALTER TABLE `collections` ADD COLUMN `vectorize` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD COLUMN `vectorize_model` text;
