-- See packages/db/drizzle/pg/20260517120000_collection_system_aliases/migration.sql
-- for the rationale.

ALTER TABLE collections ADD COLUMN created_at_column TEXT;
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN updated_at_column TEXT;
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN owner_id_column TEXT;
