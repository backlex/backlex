CREATE TABLE IF NOT EXISTS "email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"from_address" text,
	"body_html" text NOT NULL,
	"body_text" text,
	"variables" jsonb,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_templates_tenant_key_idx" ON "email_templates" ("tenant_id","key");
