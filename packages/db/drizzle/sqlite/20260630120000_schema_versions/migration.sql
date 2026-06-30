CREATE TABLE `schema_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`note` text,
	`snapshot` text NOT NULL,
	`hash` text NOT NULL,
	`kind` text DEFAULT 'manual' NOT NULL,
	`branch_id` text,
	`parent_snapshot_id` text,
	`created_by` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `schema_snapshots_tenant_idx` ON `schema_snapshots` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `schema_snapshots_branch_idx` ON `schema_snapshots` (`branch_id`);--> statement-breakpoint
CREATE TABLE `schema_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`note` text,
	`head_snapshot_id` text,
	`base_snapshot_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `schema_branches_tenant_name_idx` ON `schema_branches` (`tenant_id`,`name`);
