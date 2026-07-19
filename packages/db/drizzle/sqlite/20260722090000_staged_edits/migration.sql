-- Staged edits (#15) — SQLite/D1 twin of the pg migration. JSON stored as
-- text; timestamps as epoch-ms integers.

ALTER TABLE `collections` ADD COLUMN `staged_edits` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `item_staged` (
  `collection_id` text NOT NULL REFERENCES `collections`(`id`) ON DELETE CASCADE,
  `item_id` text NOT NULL,
  `tenant_id` text,
  `data` text NOT NULL,
  `updated_at` integer NOT NULL,
  `updated_by` text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `item_staged_pk_idx` ON `item_staged` (`collection_id`,`item_id`);
