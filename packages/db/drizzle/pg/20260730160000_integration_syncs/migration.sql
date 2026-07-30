-- Scheduled pulls from a source integration into a collection.
--
-- Separate from `integrations` because one connection legitimately feeds
-- several collections (an Airtable base has many tables); pinning it to the
-- connection row would cap a workspace at one sync per provider.
CREATE TABLE IF NOT EXISTS "integration_syncs" (
  "id" text PRIMARY KEY NOT NULL,
  "integration_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "collection" text NOT NULL,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "interval_minutes" integer DEFAULT 60 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "cursor" text,
  "last_run_at" timestamp with time zone,
  "last_row_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "disabled_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_syncs_tenant_idx" ON "integration_syncs" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_syncs_integration_idx" ON "integration_syncs" ("integration_id");--> statement-breakpoint
-- The scheduler sweeps "enabled and due", so it reads both columns together.
CREATE INDEX IF NOT EXISTS "integration_syncs_due_idx" ON "integration_syncs" ("enabled","last_run_at");
