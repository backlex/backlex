-- Staged edits (#15): a `stagedEdits` collection stores PATCHes against
-- *published* rows as a JSON sidecar patch instead of mutating the live row;
-- `publish` applies the patch. See the sqlite twin.

ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "staged_edits" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_staged" (
  "collection_id" text NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
  "item_id" text NOT NULL,
  "tenant_id" text,
  "data" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "item_staged_pk_idx" ON "item_staged" ("collection_id","item_id");
