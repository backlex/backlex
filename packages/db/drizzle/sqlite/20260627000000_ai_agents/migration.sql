CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`description` text,
	`system_prompt` text,
	`model` text,
	`tools` text DEFAULT '[]' NOT NULL,
	`max_steps` integer DEFAULT 8 NOT NULL,
	`memory` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `agent_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`agent_id` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`tool_name` text,
	`tool_args` text,
	`tool_result` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_tenant_name_idx` ON `agents` (`tenant_id`,`name`);--> statement-breakpoint
CREATE INDEX `agents_tenant_idx` ON `agents` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `agent_threads_tenant_agent_idx` ON `agent_threads` (`tenant_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_threads_agent_idx` ON `agent_threads` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_messages_thread_idx` ON `agent_messages` (`thread_id`,`created_at`);
