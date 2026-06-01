-- Third-party integrations (Slack/Discord/Datadog/GitHub) connected per
-- workspace. Data events fan out to them via @backlex/integrations. `config`
-- holds provider settings with secret fields encrypted at rest (AUTH_SECRET);
-- `events` NULL = all events, else a subscribed list.
CREATE TABLE IF NOT EXISTS "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_tenant_idx" ON "integrations" ("tenant_id");
