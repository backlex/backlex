-- See packages/db/drizzle/pg/20260703090000_external_migration/migration.sql
-- for the rationale; this is the SQLite/D1 twin.

CREATE TABLE IF NOT EXISTS external_sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT DEFAULT 'postgres' NOT NULL,
  url TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS external_sources_tenant_name_idx ON external_sources (tenant_id, name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS migration_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL,
  error TEXT,
  lease_until INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT fk_migration_runs_source_id_external_sources_id_fk
    FOREIGN KEY (source_id) REFERENCES external_sources(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS migration_runs_tenant_idx ON migration_runs (tenant_id, created_at);
