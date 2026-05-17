-- See packages/db/drizzle/pg/20260517110000_collection_adopt/migration.sql
-- for the rationale; this is the SQLite/D1 twin.

ALTER TABLE collections ADD COLUMN adopted INTEGER DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN pk_column TEXT DEFAULT 'id' NOT NULL;
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN has_created_at INTEGER DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN has_updated_at INTEGER DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS item_ownership (
  collection_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT fk_item_ownership_collection_id_collections_id_fk
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS item_ownership_pk_idx ON item_ownership (collection_id, item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_ownership_owner_idx ON item_ownership (owner_id, collection_id);
