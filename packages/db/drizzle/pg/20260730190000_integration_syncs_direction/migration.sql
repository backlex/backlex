-- A sync can now go the other way: `push` mirrors a collection out to a
-- warehouse destination. Existing rows are all pulls, hence the default.
ALTER TABLE "integration_syncs" ADD COLUMN IF NOT EXISTS "direction" text DEFAULT 'pull' NOT NULL;
