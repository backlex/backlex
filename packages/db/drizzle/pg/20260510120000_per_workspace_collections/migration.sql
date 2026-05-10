-- Per-workspace collections.
--
-- Promote `collections` from a globally-shared registry to a per-tenant
-- table: each row now belongs to exactly one tenant, and two tenants may
-- reuse the same slug independently. Existing rows (which all had a
-- nullable tenant_id) are reassigned to the first admin's active workspace,
-- falling back to the oldest tenant.
--
-- Physical `c_<slug>` tables are NOT renamed by this migration — the new
-- `physical_table` column captures whatever name they already have, so the
-- items router keeps reading the right table. Only collections created
-- AFTER this migration adopt the `c_<tenantPrefix>_<slug>` naming.

ALTER TABLE "collections" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "physical_table" text;--> statement-breakpoint

UPDATE "collections" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;--> statement-breakpoint

UPDATE "collections"
SET "tenant_id" = COALESCE(
  (
    SELECT u."active_tenant_id"
    FROM "users" u
    JOIN "user_roles" ur ON ur."user_id" = u."id"
    JOIN "roles" r ON r."id" = ur."role_id"
    WHERE r."admin" = true AND u."active_tenant_id" IS NOT NULL
    ORDER BY u."created_at" ASC
    LIMIT 1
  ),
  (SELECT "id" FROM "tenants" ORDER BY "created_at" ASC LIMIT 1)
)
WHERE "tenant_id" IS NULL;--> statement-breakpoint

UPDATE "collections" SET "physical_table" = 'c_' || "slug" WHERE "physical_table" IS NULL;--> statement-breakpoint

ALTER TABLE "collections" DROP CONSTRAINT IF EXISTS "collections_pkey";--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_pkey" PRIMARY KEY ("id");--> statement-breakpoint

ALTER TABLE "collections" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ALTER COLUMN "physical_table" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "collections"
  ADD CONSTRAINT "collections_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "collections_tenant_slug_idx" ON "collections" ("tenant_id", "slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collections_physical_table_idx" ON "collections" ("physical_table");
