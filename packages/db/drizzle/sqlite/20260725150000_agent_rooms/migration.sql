-- Agent chat rooms — SQLite/D1 twin of the pg migration. See it for the why.
--
-- SQLite can't drop a NOT NULL, so `agent_threads` is rebuilt (create-copy-
-- drop-rename) rather than altered; its indexes are recreated after the rename.
-- Timestamps are epoch-ms integers here, so the new tables use `integer`.

ALTER TABLE `agents` ADD COLUMN `handle` text;--> statement-breakpoint

-- Handle backfill: lowercased name with spaces as dashes (no regex in SQLite,
-- and unicode letters are kept anyway — mentions match the known handle list).
UPDATE `agents` SET `handle` = replace(lower(`name`), ' ', '-')
 WHERE `handle` IS NULL OR `handle` = '';--> statement-breakpoint
UPDATE `agents` SET `handle` = 'agent-' || substr(`id`, 1, 8)
 WHERE `handle` IS NULL OR `handle` = '';--> statement-breakpoint
-- Two names that slugify the same would break the unique index below. Suffix
-- the later row (ordered by id, so pg and sqlite land on the same result)…
UPDATE `agents` SET `handle` = `handle` || '-' || substr(`id`, 1, 4)
 WHERE EXISTS (
   SELECT 1 FROM `agents` b
   WHERE b.`tenant_id` IS `agents`.`tenant_id`
     AND b.`handle` = `agents`.`handle` AND b.`id` < `agents`.`id`
 );--> statement-breakpoint
-- …and fall back to the id itself if even the suffixed handles collide.
UPDATE `agents` SET `handle` = 'agent-' || `id`
 WHERE EXISTS (
   SELECT 1 FROM `agents` b
   WHERE b.`tenant_id` IS `agents`.`tenant_id`
     AND b.`handle` = `agents`.`handle` AND b.`id` < `agents`.`id`
 );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agents_tenant_handle_idx` ON `agents` (`tenant_id`,`handle`);--> statement-breakpoint

-- Rebuild agent_threads: `agent_id` goes nullable, `routing` + `default_agent_id`
-- arrive, and a pre-rooms thread keeps answering on every message ('default').
CREATE TABLE `agent_threads_new` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `agent_id` text,
  `title` text,
  `status` text DEFAULT 'idle' NOT NULL,
  `routing` text DEFAULT 'mention' NOT NULL,
  `default_agent_id` text,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `agent_threads_new`
  (`id`,`tenant_id`,`agent_id`,`title`,`status`,`routing`,`default_agent_id`,`created_by`,`created_at`,`updated_at`)
SELECT `id`,`tenant_id`,`agent_id`,`title`,`status`,
       CASE WHEN `agent_id` IS NOT NULL THEN 'default' ELSE 'mention' END,
       `agent_id`,`created_by`,`created_at`,`updated_at`
  FROM `agent_threads`;--> statement-breakpoint
DROP TABLE `agent_threads`;--> statement-breakpoint
ALTER TABLE `agent_threads_new` RENAME TO `agent_threads`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_threads_tenant_agent_idx` ON `agent_threads` (`tenant_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_threads_agent_idx` ON `agent_threads` (`agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_threads_tenant_idx` ON `agent_threads` (`tenant_id`);--> statement-breakpoint

ALTER TABLE `agent_messages` ADD COLUMN `agent_id` text;--> statement-breakpoint
-- Assistant/tool rows on a pinned thread were all written by its one agent.
UPDATE `agent_messages` SET `agent_id` = (
  SELECT t.`agent_id` FROM `agent_threads` t WHERE t.`id` = `agent_messages`.`thread_id`
) WHERE `agent_id` IS NULL AND `role` <> 'user';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_thread_agents` (
  `tenant_id` text,
  `thread_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_thread_agents_pk` ON `agent_thread_agents` (`thread_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_thread_agents_agent_idx` ON `agent_thread_agents` (`agent_id`);--> statement-breakpoint

-- Every existing thread becomes a one-participant room.
INSERT OR IGNORE INTO `agent_thread_agents` (`tenant_id`,`thread_id`,`agent_id`,`created_at`)
SELECT `tenant_id`,`id`,`agent_id`, CAST(strftime('%s','now') AS integer) * 1000
  FROM `agent_threads` WHERE `agent_id` IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `thread_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `job_id` text,
  `status` text DEFAULT 'queued' NOT NULL,
  `started_by` text,
  `trigger_message_id` text,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runs_thread_idx` ON `agent_runs` (`thread_id`,`created_at`);--> statement-breakpoint
-- The per-agent lock. Partial, so finished runs never block the next turn.
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runs_active_idx` ON `agent_runs` (`thread_id`,`agent_id`)
  WHERE `status` in ('queued','running');
