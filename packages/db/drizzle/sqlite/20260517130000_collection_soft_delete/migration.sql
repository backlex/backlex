-- See packages/db/drizzle/pg/20260517130000_collection_soft_delete/migration.sql
-- for the rationale.

ALTER TABLE collections ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN archived_at INTEGER;
