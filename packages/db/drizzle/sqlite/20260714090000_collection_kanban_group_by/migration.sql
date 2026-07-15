-- See packages/db/drizzle/pg/20260714090000_collection_kanban_group_by/migration.sql
-- for the rationale; this is the SQLite/D1 twin.

ALTER TABLE collections ADD COLUMN kanban_group_by TEXT;
