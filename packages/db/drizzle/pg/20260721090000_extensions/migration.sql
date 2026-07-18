-- Extensions (#13): installed extension packages + their file assets.
-- `manifest` is the validated backlex-extension.json; UI entries and server
-- hook code are stored per-path in `extension_assets`. See
-- packages/db/drizzle/sqlite/20260721090000_extensions for the twin.

CREATE TABLE IF NOT EXISTS "extensions" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "name" text NOT NULL,
  "version" text NOT NULL,
  "source" text NOT NULL,
  "npm_package" text,
  "manifest" jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "extensions_tenant_name_idx" ON "extensions" ("tenant_id","name");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "extension_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "extension_id" text NOT NULL,
  "path" text NOT NULL,
  "content" text NOT NULL,
  "content_type" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "extension_assets_path_idx" ON "extension_assets" ("extension_id","path");
