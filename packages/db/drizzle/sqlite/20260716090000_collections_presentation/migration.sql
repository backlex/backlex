-- Collection-level presentation metadata: admin icon + accent color, a
-- hidden-from-sidebar flag, and a preview-URL template ({{field}} placeholders).
-- See packages/db/drizzle/pg/20260716090000_collections_presentation for the twin.

ALTER TABLE `collections` ADD COLUMN `icon` text;--> statement-breakpoint
ALTER TABLE `collections` ADD COLUMN `color` text;--> statement-breakpoint
ALTER TABLE `collections` ADD COLUMN `hidden` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD COLUMN `preview_url` text;
