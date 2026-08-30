-- A tool call an agent may not make without a person's yes — SQLite/D1 twin.
-- See the pg migration for what the two columns are for and why both default
-- to empty.
--
-- Dialect difference: SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay
-- raises `duplicate column name: approval_tools`. That is safe without a guard
-- in the SQL — `auto-migrate.ts` classifies exactly that message as an
-- idempotency failure and skips the statement, which is why every other bare
-- `ADD COLUMN` in this directory is replayable too.
--
-- The breakpoint marker between the two statements below is not decoration:
-- drizzle's migrator splits a file on it, and without one a two-statement file
-- silently applies only the first. Caught by probing PRAGMA table_info(agents)
-- after a migrate, which had approval_tools and no approvers.
--
-- Do not write that marker inside a comment. Splitting is textual, so a mention
-- of it produces a comment-only chunk, and bun:sqlite prepares that as an
-- already-finalized statement: the whole migration then dies with "Statement
-- has finalized" and takes every other migration with it.

ALTER TABLE `agents` ADD COLUMN `approval_tools` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `approvers` text DEFAULT '[]' NOT NULL;
