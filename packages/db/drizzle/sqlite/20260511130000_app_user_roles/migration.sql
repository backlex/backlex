-- Role assignments for workspace end-users (the app_users pool). Mirrors the
-- PG migration. Additive only.

CREATE TABLE `app_user_roles` (
	`app_user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_app_user_roles_app_user_id_app_users_id_fk` FOREIGN KEY (`app_user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_app_user_roles_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_roles_pk` ON `app_user_roles` (`app_user_id`,`role_id`);--> statement-breakpoint
CREATE INDEX `app_user_roles_role_idx` ON `app_user_roles` (`role_id`);
