CREATE TABLE IF NOT EXISTS "phone_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"user_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_numbers_unique_idx" ON "phone_numbers" ("user_id","phone_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_numbers_user_idx" ON "phone_numbers" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_numbers_tenant_idx" ON "phone_numbers" ("tenant_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_config" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'inherit' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
