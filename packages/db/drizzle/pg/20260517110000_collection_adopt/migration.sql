-- Collection adoption + side-table ownership.
--
-- Four flags on `collections` carry the metadata an adopted (existing) table
-- needs that managed (we-created) tables already imply:
--   * adopted        — distinguishes the two; flips `applyCollection` to a
--                      no-op and stops `dropCollection` from touching the
--                      physical table.
--   * pk_column      — name of the PK column on the physical table. Default
--                      `id` (every managed collection). Adoption surfaces
--                      this for source tables that use a different PK name.
--   * has_created_at /
--     has_updated_at — managed collections always have these; adopted ones
--                      may not. Affects POST/PATCH writes, projection, and
--                      the `parseQuery` default-sort fallback.
--
-- `item_ownership` is the side-table for row ownership. We move ownership
-- here (instead of an `owner_id` column on every `c_<slug>`) so that
--   (1) adopted tables stay non-invasive — no DDL on the user's table;
--   (2) toggling `ownerScoped` off no longer leaves orphan columns behind.
-- Permission filters compile `owner_id` references to a semi-join against
-- this table; `routes/items.ts` LEFT JOINs it on read to surface the
-- resolved `owner_id` in the API response. Managed collections continue to
-- store `owner_id` on the physical row for now — the migration that would
-- consolidate them is a separate piece of work.

ALTER TABLE "collections" ADD COLUMN "adopted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "pk_column" text DEFAULT 'id' NOT NULL;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "has_created_at" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "has_updated_at" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_ownership" (
  "collection_id" text NOT NULL,
  "item_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fk_item_ownership_collection_id_collections_id_fk"
    FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "item_ownership_pk_idx" ON "item_ownership" ("collection_id", "item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_ownership_owner_idx" ON "item_ownership" ("owner_id", "collection_id");
