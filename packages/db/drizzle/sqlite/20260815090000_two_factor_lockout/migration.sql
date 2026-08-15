-- Two-factor lockout state — SQLite/D1 twin of the pg migration. See that file
-- for why better-auth 1.6.29 makes these columns mandatory rather than optional
-- (its Drizzle adapter validates the model by property name and 500s on every
-- two-factor endpoint without them).
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so unlike the pg twin these two
-- statements DO fail on replay with "duplicate column name". That is the
-- expected path: `auto-migrate.ts` tolerates exactly this class of error for
-- `ADD COLUMN`, the same way the resilience-retention migration relies on it.
-- Do not rewrite these as a table rebuild to make them idempotent — the rebuild
-- would drop the foreign key that `twoFactor` carries on `user_id`.
--
-- `locked_until` is `integer` because the SQLite schema stores dates as
-- `timestamp_ms`; NULL means "not locked".

ALTER TABLE `twoFactor` ADD COLUMN `failed_verification_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `twoFactor` ADD COLUMN `locked_until` integer;
