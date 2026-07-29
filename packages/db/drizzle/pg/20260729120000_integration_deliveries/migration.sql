-- Durable integration delivery: an audit trail per attempt plus the circuit
-- breaker columns on `integrations`, mirroring what `webhooks` already carries.
-- Event fan-out moves from a fire-and-forget `void dispatch(...)` to queued
-- `integration.deliver` jobs, so a failing provider is retried with backoff,
-- dead-lettered, and eventually paused instead of silently dropping events.

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "disabled_reason" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "integration_id" text NOT NULL,
  "tenant_id" text,
  "event" text NOT NULL,
  "status" integer NOT NULL,
  "ms" integer NOT NULL,
  "error" text,
  "attempts" integer DEFAULT 1 NOT NULL,
  "delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_deliveries_integration_idx"
  ON "integration_deliveries" ("integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_deliveries_tenant_idx"
  ON "integration_deliveries" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_deliveries_at_idx"
  ON "integration_deliveries" ("delivered_at");
