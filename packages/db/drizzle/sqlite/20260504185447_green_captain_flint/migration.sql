CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY,
	`prefix` text NOT NULL,
	`hashed_key` text NOT NULL,
	`name` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_api_keys_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hashed_idx` ON `api_keys` (`hashed_key`);--> statement-breakpoint
CREATE INDEX `api_keys_prefix_idx` ON `api_keys` (`prefix`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);