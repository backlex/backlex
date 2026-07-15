-- Collection-level presentation metadata: admin icon + accent color, a
-- hidden-from-sidebar flag, and a preview-URL template ({{field}} placeholders).
-- See packages/db/drizzle/sqlite/20260716090000_collections_presentation for the twin.

ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "preview_url" text;
