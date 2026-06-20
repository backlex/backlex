CREATE TABLE IF NOT EXISTS "feature_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"value" jsonb,
	"rules" jsonb,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feature_flags_unique_idx" ON "feature_flags" ("tenant_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_flags_tenant_idx" ON "feature_flags" ("tenant_id");
