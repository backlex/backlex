-- Payments integration — connected providers + the verified webhook event log.
--
-- The synced business data (customers / subscriptions / invoices / payments)
-- does NOT live here: it lands in ordinary managed collections, so it inherits
-- the permission DSL, REST/GraphQL querying, realtime and the BI panels. These
-- two tables only hold the connection and the delivery log.

CREATE TABLE IF NOT EXISTS "payment_providers" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "provider" text NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'connected' NOT NULL,
  "webhook_token" text NOT NULL,
  "sync_cursor" jsonb,
  "last_event_at" timestamptz,
  "last_sync_at" timestamptz,
  "last_sync_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One connection per (workspace, provider); the token is the public URL
-- segment, so it must be globally unique to route a delivery unambiguously.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_providers_tenant_provider_idx"
  ON "payment_providers" ("tenant_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_providers_token_idx"
  ON "payment_providers" ("webhook_token");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payment_events" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "provider_id" text NOT NULL,
  "external_id" text NOT NULL,
  "type" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "record_count" integer DEFAULT 0 NOT NULL,
  "error" text,
  "payload" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz
);--> statement-breakpoint
-- The replay guard: a retried delivery conflicts here and is acknowledged
-- without re-applying its rows.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_events_dedupe_idx"
  ON "payment_events" ("provider_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_events_tenant_created_idx"
  ON "payment_events" ("tenant_id","created_at");
