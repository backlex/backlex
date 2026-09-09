-- Who authored a function — SQLite/D1 twin. See the pg migration for what the
-- columns are for, and for why NULL rather than a backfilled value is the
-- decision rather than an omission.
--
-- Dialect difference: SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay
-- raises `duplicate column name: created_by`. That is safe without a guard —
-- `auto-migrate.ts` classifies exactly that message as an idempotency failure
-- and skips the statement, which is why every other bare `ADD COLUMN` in this
-- directory is replayable too.
--
-- The breakpoint marker between the statements below is load-bearing: drizzle's
-- migrator splits a file on it, and without one a multi-statement file silently
-- applies only the first. Do not write that marker inside a comment — the split
-- is textual, so a mention of it produces a comment-only chunk that bun:sqlite
-- prepares as an already-finalized statement, which kills every migration with
-- "Statement has finalized".

ALTER TABLE `functions` ADD COLUMN `created_by` text;--> statement-breakpoint
ALTER TABLE `functions` ADD COLUMN `author_kind` text;
