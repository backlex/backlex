CREATE TABLE IF NOT EXISTS "dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"description" text,
	"layout" jsonb,
	"embed_enabled" boolean DEFAULT false NOT NULL,
	"embed_token_hash" text,
	"embed_role_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboards_tenant_idx" ON "dashboards" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dashboards_embed_token_idx" ON "dashboards" ("embed_token_hash");--> statement-breakpoint
ALTER TABLE "saved_panels" ADD COLUMN IF NOT EXISTS "dashboard_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_panels_dashboard_idx" ON "saved_panels" ("dashboard_id");
