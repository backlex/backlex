-- An agent an end user is allowed to talk to — SQLite/D1 twin. See the pg
-- migration for why the default is false and why that is the whole point.
--
-- No `IF NOT EXISTS` (SQLite does not accept it on ADD COLUMN); a replay raises
-- "duplicate column name", which `auto-migrate.ts` tolerates.

ALTER TABLE `agents` ADD COLUMN `app_access` integer NOT NULL DEFAULT 0;
