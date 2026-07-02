-- See packages/db/drizzle/pg/20260702150000_collection_pk_type/migration.sql
-- for the rationale; this is the SQLite/D1 twin.

ALTER TABLE collections ADD COLUMN pk_type TEXT DEFAULT 'uuid' NOT NULL;
