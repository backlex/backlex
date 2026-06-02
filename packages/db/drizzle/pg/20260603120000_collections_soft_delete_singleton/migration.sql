-- Two collection-level toggles surfaced by the "New collection" wizard that
-- previously had no backing storage:
--   * soft_delete — when true the physical table carries a nullable
--                   `deleted_at` column, DELETE soft-deletes (sets the
--                   timestamp) instead of removing the row, and every read
--                   path filters `deleted_at IS NULL`. Forced false for
--                   adopted collections (no DDL on the source table).
--   * singleton   — locks the collection to a single live row; inserts are
--                   rejected once one exists.

ALTER TABLE "collections" ADD COLUMN "soft_delete" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "singleton" boolean DEFAULT false NOT NULL;
