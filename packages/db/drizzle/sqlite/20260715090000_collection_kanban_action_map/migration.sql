-- See packages/db/drizzle/pg/20260715090000_collection_kanban_action_map/migration.sql
-- for the rationale; this is the SQLite/D1 twin. JSON is stored as text.

ALTER TABLE collections ADD COLUMN kanban_action_map TEXT;
