-- Usage metering (#12): per-day usage ledger + per-API-key limit knobs.
-- `usage_counters` holds one row per (workspace, api key, UTC day); request
-- counts arrive via buffered ON CONFLICT upserts, storage/rows gauges via the
-- cron sweep. `api_key_id = ''` buckets non-key traffic so the composite key
-- stays non-nullable. See packages/db/drizzle/sqlite/20260720090000_usage_metering
-- for the twin.

CREATE TABLE IF NOT EXISTS "usage_counters" (
  "tenant_id" text NOT NULL,
  "api_key_id" text DEFAULT '' NOT NULL,
  "day" text NOT NULL,
  "requests" integer DEFAULT 0 NOT NULL,
  "errors" integer DEFAULT 0 NOT NULL,
  "storage_bytes" bigint,
  "db_rows" bigint,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_counters_pk" ON "usage_counters" ("tenant_id","api_key_id","day");--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rate_limit_per_minute" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "monthly_quota" integer;
