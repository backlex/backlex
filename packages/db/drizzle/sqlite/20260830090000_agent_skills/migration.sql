-- Reusable procedural knowledge an agent can consult — SQLite/D1 twin. See the
-- pg migration for what the table is for and why the shape is the open Agent
-- Skills one.
--
-- Dialect difference: SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay
-- raises `duplicate column name: skills`. That is safe without a guard —
-- `auto-migrate.ts` classifies exactly that message as an idempotency failure
-- and skips the statement, which is why every other bare `ADD COLUMN` in this
-- directory is replayable too.
--
-- The breakpoint markers between the statements below are load-bearing:
-- drizzle's migrator splits a file on them, and without one a multi-statement
-- file silently applies only the first. Do not write that marker inside a
-- comment — the split is textual, so a mention of it produces a comment-only
-- chunk that bun:sqlite prepares as an already-finalized statement, which kills
-- every migration with "Statement has finalized".

CREATE TABLE IF NOT EXISTS `agent_skills` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `body` text NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_skills_tenant_idx` ON `agent_skills` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_skills_tenant_name_idx` ON `agent_skills` (`tenant_id`,`name`);--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `skills` text DEFAULT '[]' NOT NULL;
