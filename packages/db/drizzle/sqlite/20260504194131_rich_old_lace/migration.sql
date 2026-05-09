CREATE TABLE `folders` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`parent_id` text,
	`owner_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `files` ADD `folder_id` text REFERENCES folders(id);--> statement-breakpoint
CREATE INDEX `files_folder_idx` ON `files` (`folder_id`);--> statement-breakpoint
CREATE INDEX `folders_parent_idx` ON `folders` (`parent_id`);