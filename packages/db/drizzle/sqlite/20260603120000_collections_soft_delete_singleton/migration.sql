-- See packages/db/drizzle/pg/20260603120000_collections_soft_delete_singleton/migration.sql
-- for the rationale; this is the SQLite/D1 twin.

ALTER TABLE collections ADD COLUMN soft_delete INTEGER DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN singleton INTEGER DEFAULT 0 NOT NULL;
