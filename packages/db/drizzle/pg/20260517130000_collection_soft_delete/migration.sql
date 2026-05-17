-- Lifecycle status for collections, paired with an archive-time stamp.
-- `status = 'active'` (default) is the normal state; `'archived'` is the
-- soft-archived state used only by *adopted* collections (managed `c_*`
-- collections are hard-deleted on DELETE because the physical table is
-- dropped — there's nothing to restore).
--
-- The pattern mirrors the existing `versioned` collections' `_status` +
-- `_published_at` columns: a discrete status field carries the lifecycle
-- transition, with a timestamp for the most recent flip.

ALTER TABLE "collections" ADD COLUMN "status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "archived_at" timestamp with time zone;
