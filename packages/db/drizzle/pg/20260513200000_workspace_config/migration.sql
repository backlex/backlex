CREATE TABLE IF NOT EXISTS "workspace_config" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"workspace_name" text,
	"description" text,
	"logo_file_key" text,
	"favicon_file_key" text,
	"primary_color" text,
	"default_theme" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
