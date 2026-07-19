CREATE TABLE `oauth_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`metadata` text,
	`client_id` text NOT NULL,
	`client_secret` text,
	`redirect_urls` text NOT NULL,
	`type` text NOT NULL,
	`authentication_scheme` text,
	`disabled` integer DEFAULT 0 NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_oauth_applications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_app_client_idx` ON `oauth_applications` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_app_user_idx` ON `oauth_applications` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token_expires_at` integer NOT NULL,
	`refresh_token_expires_at` integer NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_oauth_access_tokens_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `oauth_applications`(`client_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_oauth_access_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_token_access_idx` ON `oauth_access_tokens` (`access_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_token_refresh_idx` ON `oauth_access_tokens` (`refresh_token`);--> statement-breakpoint
CREATE INDEX `oauth_token_client_idx` ON `oauth_access_tokens` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_token_user_idx` ON `oauth_access_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`consent_given` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_oauth_consents_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `oauth_applications`(`client_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_oauth_consents_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX `oauth_consent_client_idx` ON `oauth_consents` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_consent_user_idx` ON `oauth_consents` (`user_id`);
