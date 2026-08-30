-- An invite token stops being readable at rest — SQLite/D1 twin.
-- See the pg migration for why the plaintext columns survive, what the
-- follow-up migration is called, and why `app_org_invites.token` stays
-- NOT NULL.
--
-- Dialect notes:
--   * SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay raises `duplicate
--     column name: invite_token_hash`. That is safe without a guard because
--     `auto-migrate.ts` classifies that exact message as an idempotency
--     failure (`ALREADY_EXISTS_RE` matches `duplicate column`) and skips the
--     statement — the same reason every other bare `ADD COLUMN` in this
--     directory is replayable. The two ledger-driven runners never reach that
--     path at all: `src/sqlite/migrate.ts` and `migrate-d1.ts` both skip a
--     migration whose sha256 is already recorded in `__drizzle_migrations`.
--   * Both columns are nullable with no DEFAULT, so existing rows read back
--     NULL and are served by the plaintext fallback in `services/invites.ts`
--     until they are accepted or expire.
--   * The unique index on `app_org_invites.token_hash` tolerates the all-NULL
--     column it lands on: SQLite (like Postgres) treats NULLs as distinct in a
--     unique index, so every legacy row coexists.

ALTER TABLE `tenant_members` ADD COLUMN `invite_token_hash` text;--> statement-breakpoint
ALTER TABLE `app_org_invites` ADD COLUMN `token_hash` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenant_members_invite_token_hash_idx` ON `tenant_members` (`invite_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `app_org_invites_token_hash_idx` ON `app_org_invites` (`token_hash`);
