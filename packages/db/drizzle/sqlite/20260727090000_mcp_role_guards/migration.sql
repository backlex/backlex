-- Role-scoped MCP guards — SQLite/D1 twin of the pg migration. See it for the why.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; the runner applies each migration
-- folder exactly once (tracked by hash in the manifest), so a plain ADD COLUMN
-- is correct here and matches every other additive migration in this tree.

ALTER TABLE `roles` ADD COLUMN `mcp_tools` text;--> statement-breakpoint
ALTER TABLE `roles` ADD COLUMN `mcp_read_only` integer DEFAULT false NOT NULL;
