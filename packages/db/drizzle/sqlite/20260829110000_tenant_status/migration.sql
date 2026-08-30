-- A workspace now has a lifecycle — SQLite/D1 twin.
-- See the pg migration for the value set, for why `provisioning` is absent, and
-- for why `archived_at` is not back-filled.
--
-- Dialect notes:
--   * SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay raises `duplicate
--     column name: status`. That is safe without a guard in the SQL because
--     `auto-migrate.ts` classifies that exact message as an idempotency failure
--     (`ALREADY_EXISTS_RE` matches `duplicate column`) and skips the statement —
--     the same reason every other bare `ADD COLUMN` in this directory is
--     replayable. The two ledger-driven runners never reach that path at all:
--     `src/sqlite/migrate.ts` and `migrate-d1.ts` both skip a migration whose
--     sha256 is already recorded in `__drizzle_migrations`.
--   * SQLite refuses `ADD COLUMN ... NOT NULL` unless a non-null DEFAULT comes
--     with it, which is exactly the shape wanted here: existing rows are filled
--     with 'active' as the column is added, so there is no back-fill statement
--     and no window in which a live workspace reads back NULL.
--   * `archived_at` is an epoch-milliseconds integer, matching every other
--     nullable timestamp in this schema (`tenant_members.invited_at` and
--     friends); the pg twin is `timestamp with time zone`.

ALTER TABLE `tenants` ADD COLUMN `status` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE `tenants` ADD COLUMN `archived_at` integer;
