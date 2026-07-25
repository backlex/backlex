-- Per-agent reasoning effort — SQLite/D1 twin of the pg migration.

ALTER TABLE `agents` ADD COLUMN `effort` text;
