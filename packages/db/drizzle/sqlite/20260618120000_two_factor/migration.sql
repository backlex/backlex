ALTER TABLE `users` ADD COLUMN `two_factor_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE `twoFactor` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`verified` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_two_factor_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX `two_factor_user_idx` ON `twoFactor` (`user_id`);
