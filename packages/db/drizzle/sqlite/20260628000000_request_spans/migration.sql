CREATE TABLE `spans` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'server' NOT NULL,
	`method` text,
	`path` text,
	`status` integer,
	`user_id` text,
	`duration_ms` integer,
	`attributes` text,
	`started_at` integer NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `spans_trace_idx` ON `spans` (`trace_id`);--> statement-breakpoint
CREATE INDEX `spans_tenant_idx` ON `spans` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `spans_created_idx` ON `spans` (`created_at`);
