-- Public form builder: embeddable anonymous forms whose submissions land in a
-- collection via the items write core. Token stored as SHA-256 hash only.
-- See packages/db/drizzle/sqlite/20260718090000_forms for the twin.

CREATE TABLE IF NOT EXISTS "forms" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"collection" text NOT NULL,
	"token_hash" text NOT NULL,
	"fields" jsonb NOT NULL,
	"settings" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forms_token_idx" ON "forms" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forms_tenant_idx" ON "forms" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forms_collection_idx" ON "forms" ("collection");
