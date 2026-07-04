-- Admin grouping + manual ordering of collections (Collections page +
-- sidebar tree). Column is `group_name` because GROUP is reserved in both
-- dialects; the JSON key over the wire stays `group`. Group-header order
-- lives in the `collectionGroups` app_settings key; null group renders as
-- "Ungrouped" (last), null sort_order sorts after explicitly-ordered rows.

ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "group_name" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "sort_order" integer;
