-- One-shot patch for the deployed D1 "workeros" database to bring the
-- `collections` table up to the per-workspace shape that the new code
-- expects. The previous manual hotfix added `physical_table` and
-- backfilled `tenant_id` on existing rows; this script adds the missing
-- `id` column, then rebuilds the table to apply the new PK + NOT NULL
-- constraints + unique indexes.
--
-- Apply once with:
--   wrangler d1 execute workeros --remote \
--     --file=scripts/d1-per-workspace-collections.sql

-- Step 1: add the missing id column and backfill it for existing rows.
ALTER TABLE collections ADD COLUMN id text;
UPDATE collections SET id = lower(hex(randomblob(16))) WHERE id IS NULL;

-- Step 2: rebuild the table to swap PK from slug → id, enforce NOT NULL,
-- add the FK + unique indexes. SQLite cannot ALTER PRIMARY KEY in place
-- so we go through the standard "create new, copy, swap" pattern.
PRAGMA foreign_keys = OFF;

CREATE TABLE __new_collections (
  id text PRIMARY KEY NOT NULL,
  slug text NOT NULL,
  tenant_id text NOT NULL,
  physical_table text NOT NULL,
  singular text,
  plural text,
  note text,
  display_template text,
  fields text NOT NULL,
  owner_scoped integer DEFAULT 0 NOT NULL,
  tenant_scoped integer DEFAULT 1 NOT NULL,
  versioned integer DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT fk_collections_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

INSERT INTO __new_collections (
  id, slug, tenant_id, physical_table,
  singular, plural, note, display_template, fields,
  owner_scoped, tenant_scoped, versioned, created_at, updated_at
)
SELECT
  id, slug, tenant_id, physical_table,
  singular, plural, note, display_template, fields,
  owner_scoped, tenant_scoped, versioned, created_at, updated_at
FROM collections;

DROP TABLE collections;
ALTER TABLE __new_collections RENAME TO collections;

CREATE UNIQUE INDEX collections_tenant_slug_idx
  ON collections (tenant_id, slug);
CREATE UNIQUE INDEX collections_physical_table_idx
  ON collections (physical_table);

PRAGMA foreign_keys = ON;
