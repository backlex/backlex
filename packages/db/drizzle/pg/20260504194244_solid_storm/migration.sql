CREATE TABLE "revisions" (
	"id" text PRIMARY KEY,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"parent_revision_id" text,
	"snapshot" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "revisions_item_idx" ON "revisions" ("collection","item_id");