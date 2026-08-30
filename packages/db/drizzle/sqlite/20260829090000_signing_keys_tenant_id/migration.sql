-- A signing key can now say which workspace it belongs to — SQLite/D1 twin.
-- See the pg migration for why the column is nullable, why nothing is
-- back-filled, and why no reader filters on it yet.
--
-- Dialect difference: SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay
-- raises `duplicate column name: tenant_id`. That is safe without a guard in
-- the SQL because `auto-migrate.ts` classifies that exact message as an
-- idempotency failure (`ALREADY_EXISTS_RE` matches `duplicate column`) and
-- skips the statement — the same reason every other bare `ADD COLUMN` in this
-- directory is replayable. The two ledger-driven runners never reach that path
-- at all: `src/sqlite/migrate.ts` and `migrate-d1.ts` both skip a migration
-- whose sha256 is already recorded in `__drizzle_migrations`.

ALTER TABLE `signing_keys` ADD COLUMN `tenant_id` text;
