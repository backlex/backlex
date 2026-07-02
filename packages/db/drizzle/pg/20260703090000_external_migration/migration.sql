-- Server-side external-DB migration (Phase 2 of docs/migrating-in.md).
--
-- `external_sources` stores saved connections for the admin "Database
-- import" wizard. The connection string is encrypted at rest with
-- AUTH_SECRET (lib/crypto envelope, same as integration configs) and is
-- always masked on the API — only the copy executor decrypts it.
--
-- `migration_runs` is one migration execution. The scheduler tick claims
-- runs lease-based (stale-lease reclaim, same model as the job queue) and
-- copies in bounded slices; `state` carries per-table keyset cursors +
-- counters so a run survives isolate death and resumes exactly where it
-- left off — safe because the ingest path is idempotent.

CREATE TABLE IF NOT EXISTS "external_sources" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "kind" text DEFAULT 'postgres' NOT NULL,
  "url" text NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_sources_tenant_name_idx" ON "external_sources" ("tenant_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "migration_runs" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "source_id" text NOT NULL,
  "plan" jsonb NOT NULL,
  "state" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "lease_until" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fk_migration_runs_source_id_external_sources_id_fk"
    FOREIGN KEY ("source_id") REFERENCES "external_sources"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "migration_runs_tenant_idx" ON "migration_runs" ("tenant_id", "created_at");
