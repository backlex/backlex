CREATE TABLE `permissions` (
	`id` text PRIMARY KEY,
	`role_id` text NOT NULL,
	`collection` text NOT NULL,
	`action` text NOT NULL,
	`fields` text,
	`condition` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_permissions_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text,
	`admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_user_roles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_user_roles_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `permissions_role_idx` ON `permissions` (`role_id`);--> statement-breakpoint
CREATE INDEX `permissions_lookup_idx` ON `permissions` (`collection`,`action`);--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_idx` ON `roles` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_pk` ON `user_roles` (`user_id`,`role_id`);--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role_id`);