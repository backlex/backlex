-- CDC sinks — the changefeed, delivered somewhere.
--
-- `/{slug}/changes` already produces the hard part: an incremental feed with
-- delete tombstones and shape move-out markers, keyset-paginated so a reader
-- can resume exactly. It had no consumer other than a client that polls it.
--
-- `cursor` is the whole design: it is the changefeed's own cursor and advances
-- only after a delivery is acknowledged, so a sink is at-least-once and never
-- at-most-once. The alternative loses rows on any failure and nobody can tell
-- which ones.

CREATE TABLE IF NOT EXISTS "cdc_sinks" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "collection" text NOT NULL,
  "destination" text NOT NULL,
  "config" jsonb NOT NULL,
  "shape" text,
  "fields" text,
  "batch_size" integer DEFAULT 100 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "cursor" text,
  "last_run_at" timestamp with time zone,
  "last_error" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "disabled_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_sinks_tenant_idx" ON "cdc_sinks" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_sinks_enabled_idx" ON "cdc_sinks" ("enabled");
