CREATE TABLE IF NOT EXISTS "shared_links" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shared_links_token_idx" ON "shared_links" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_links_item_idx" ON "shared_links" ("collection","item_id");
