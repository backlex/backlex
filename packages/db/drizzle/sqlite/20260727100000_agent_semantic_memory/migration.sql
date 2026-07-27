-- Episodic/semantic split for agent memory — SQLite/D1 twin of the pg
-- migration. See it for the why. Timestamps are epoch-ms integers here.

ALTER TABLE `agents` ADD COLUMN `memory_scope` text DEFAULT 'thread' NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_memories` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `agent_id` text NOT NULL,
  `thread_id` text,
  `scope` text DEFAULT 'thread' NOT NULL,
  `content` text NOT NULL,
  `embedded` integer DEFAULT false NOT NULL,
  `hits` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_memories_agent_idx` ON `agent_memories` (`agent_id`,`scope`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_memories_thread_idx` ON `agent_memories` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_memories_tenant_idx` ON `agent_memories` (`tenant_id`);
