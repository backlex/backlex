CREATE TABLE `shared_links` (
	`id` text PRIMARY KEY,
	`tenant_id` text,
	`collection` text NOT NULL,
	`item_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_links_token_idx` ON `shared_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `shared_links_item_idx` ON `shared_links` (`collection`,`item_id`);
