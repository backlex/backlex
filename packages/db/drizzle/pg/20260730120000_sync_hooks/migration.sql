-- Synchronous hooks: an external service that participates in a write rather
-- than being told about it afterwards. Runs before the row is written and can
-- reject it or patch the payload. `on_error` has no DB default on purpose —
-- allow-vs-deny is the operator's call, and guessing it either drops the
-- guarantee the hook provides or turns the app's outage into theirs.

CREATE TABLE IF NOT EXISTS "sync_hooks" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "secret" text,
  "events" jsonb NOT NULL,
  "headers" jsonb,
  "timeout_ms" integer DEFAULT 2000 NOT NULL,
  "on_error" text NOT NULL,
  "can_mutate" boolean DEFAULT false NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_failure_at" timestamp with time zone,
  "disabled_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_hooks_tenant_idx" ON "sync_hooks" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_hooks_enabled_idx" ON "sync_hooks" ("enabled");
