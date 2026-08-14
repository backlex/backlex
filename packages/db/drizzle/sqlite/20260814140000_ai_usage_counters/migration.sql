-- AI usage joins the ledger — SQLite/D1 twin. See the pg migration for why
-- there are four columns rather than one, and why AI usage is not derivable
-- from the request count.
--
-- No `IF NOT EXISTS`: SQLite does not accept it on ADD COLUMN. A replay raises
-- "duplicate column name", which `auto-migrate.ts`'s ALREADY_EXISTS_RE matches,
-- so the migration stays replayable the same way the resilience one does.

ALTER TABLE `usage_counters` ADD COLUMN `ai_calls` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `usage_counters` ADD COLUMN `ai_tokens_in` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `usage_counters` ADD COLUMN `ai_tokens_out` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `usage_counters` ADD COLUMN `ai_neurons` integer NOT NULL DEFAULT 0;
