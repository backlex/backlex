-- Tenant-scope storage folders.
--
-- Adds the missing `tenant_id` column to `folders` so the folder tree no
-- longer leaks across workspaces. Existing rows are back-filled with the
-- default tenant (the same one tenantMiddleware lands legacy data on) so
-- the admin UI keeps working without orphaning historical folders.

ALTER TABLE "folders" ADD COLUMN "tenant_id" text;--> statement-breakpoint

UPDATE "folders"
SET "tenant_id" = (
  SELECT "id" FROM "tenants" WHERE "slug" = 'default' LIMIT 1
)
WHERE "tenant_id" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "folders_tenant_idx" ON "folders" ("tenant_id");
