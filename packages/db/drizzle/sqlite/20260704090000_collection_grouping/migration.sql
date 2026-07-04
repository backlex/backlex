-- See packages/db/drizzle/pg/20260704090000_collection_grouping/migration.sql
-- for the rationale; this is the SQLite/D1 twin.

ALTER TABLE collections ADD COLUMN group_name TEXT;--> statement-breakpoint
ALTER TABLE collections ADD COLUMN sort_order INTEGER;
