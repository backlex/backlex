-- Public form builder: embeddable anonymous forms whose submissions land in a
-- collection via the items write core. Token stored as SHA-256 hash only.
-- See packages/db/drizzle/pg/20260718090000_forms for the twin.

CREATE TABLE `forms` (
	`id` text PRIMARY KEY,
	`tenant_id` text,
	`name` text NOT NULL,
	`collection` text NOT NULL,
	`token_hash` text NOT NULL,
	`fields` text NOT NULL,
	`settings` text,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forms_token_idx` ON `forms` (`token_hash`);--> statement-breakpoint
CREATE INDEX `forms_tenant_idx` ON `forms` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `forms_collection_idx` ON `forms` (`collection`);
