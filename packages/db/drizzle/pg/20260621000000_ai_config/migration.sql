CREATE TABLE IF NOT EXISTS "ai_config" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'inherit' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
