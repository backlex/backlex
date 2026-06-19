CREATE TABLE IF NOT EXISTS "device_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"keys" jsonb,
	"device_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_tokens_unique_idx" ON "device_tokens" ("user_id","platform","token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_tokens_user_idx" ON "device_tokens" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_tokens_tenant_idx" ON "device_tokens" ("tenant_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_config" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'inherit' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text,
	"variables" jsonb,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_templates_tenant_key_idx" ON "push_templates" ("tenant_id","key");
