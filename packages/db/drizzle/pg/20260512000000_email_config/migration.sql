CREATE TABLE IF NOT EXISTS "email_config" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'inherit' NOT NULL,
	"from_address" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
