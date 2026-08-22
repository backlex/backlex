-- What a site does with Global Privacy Control and Do Not Track — SQLite/D1
-- twin. See the pg migration for the three values, why the default is the
-- behaviour that is already live, and why this is NOT in the consent artifact.
--
-- Dialect difference: SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay
-- raises `duplicate column name: signal_handling`. That is safe here without a
-- guard in the SQL, because `auto-migrate.ts` classifies exactly that message
-- as an idempotency failure and skips the statement — the same reason every
-- other bare `ADD COLUMN` in this directory is replayable. Do not "fix" this by
-- rebuilding the table; that would drop the ledger's ability to tell a re-apply
-- from a real schema bug.

ALTER TABLE `consent_policies` ADD COLUMN `signal_handling` text DEFAULT 'tracker' NOT NULL;
