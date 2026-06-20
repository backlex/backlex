CREATE TABLE IF NOT EXISTS "uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"key" text NOT NULL,
	"physical_key" text NOT NULL,
	"storage_upload_id" text,
	"size" integer NOT NULL,
	"offset" integer DEFAULT 0 NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_type" text,
	"folder_id" text,
	"owner_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploads_tenant_idx" ON "uploads" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploads_expires_idx" ON "uploads" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploads_status_idx" ON "uploads" ("status");
