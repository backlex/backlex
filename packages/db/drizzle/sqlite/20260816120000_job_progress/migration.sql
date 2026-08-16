-- How far a long-running job has got — SQLite/D1 twin. See the pg migration for
-- the shape and for why NULL means "has not reported" rather than "0%".
--
-- Stored as `text` in json mode, which is what every other json column in the
-- SQLite schema does (`payload`, `result`).
--
-- No `IF NOT EXISTS` (SQLite does not accept it on ADD COLUMN); a replay raises
-- "duplicate column name", which `auto-migrate.ts` tolerates for exactly this
-- statement shape.

ALTER TABLE `jobs` ADD COLUMN `progress` text;
