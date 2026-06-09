-- See packages/db/drizzle/pg/20260609120000_collections_audit_reads/migration.sql
-- for the rationale; this is the SQLite/D1 twin.

ALTER TABLE collections ADD COLUMN audit_reads INTEGER DEFAULT 0 NOT NULL;
