-- PG chain column back-fills.
--
-- Slots in AFTER the chain has created its base tables (users, collections,
-- activity, comments, flows, functions, revisions, webhooks, files) and
-- BEFORE `20260510120000_per_workspace_collections` reads
-- `users.active_tenant_id` / `collections.tenant_id` in its back-fill UPDATE.
--
-- Mirrors the SQLite-only migrations `20260509212015_talented_machine_man`
-- (the bulk of the tenant-aware columns + indexes) and `20260509222951`
-- (`users.is_anonymous`). Without these the PG chain can't progress past
-- `per_workspace_collections`. See packages/db/src/pg/schema.ts for the final
-- target shape.

-- users — tenant + lifecycle bookkeeping.
ALTER TABLE "users" ADD COLUMN "active_tenant_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- collections — tenant scoping. `per_workspace_collections` later flips
-- `tenant_id` to NOT NULL + adds the FK.
ALTER TABLE "collections" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "tenant_scoped" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "versioned" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- activity — tenant + request duration.
ALTER TABLE "activity" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
CREATE INDEX "activity_tenant_idx" ON "activity" ("tenant_id");--> statement-breakpoint

-- files — tenant + ACL.
ALTER TABLE "files" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "acl" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX "files_tenant_idx" ON "files" ("tenant_id");--> statement-breakpoint

-- flows — tenant scope.
ALTER TABLE "flows" ADD COLUMN "tenant_id" text;--> statement-breakpoint
CREATE INDEX "flows_tenant_idx" ON "flows" ("tenant_id");--> statement-breakpoint

-- functions — tenant scope. Replace the global unique `functions_name_idx`
-- with the per-tenant `functions_tenant_name_idx`.
ALTER TABLE "functions" ADD COLUMN "tenant_id" text;--> statement-breakpoint
DROP INDEX IF EXISTS "functions_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "functions_tenant_name_idx" ON "functions" ("tenant_id","name");--> statement-breakpoint

-- revisions — tenant scope.
ALTER TABLE "revisions" ADD COLUMN "tenant_id" text;--> statement-breakpoint
CREATE INDEX "revisions_tenant_idx" ON "revisions" ("tenant_id");--> statement-breakpoint

-- webhooks — tenant scope.
ALTER TABLE "webhooks" ADD COLUMN "tenant_id" text;--> statement-breakpoint
CREATE INDEX "webhooks_tenant_idx" ON "webhooks" ("tenant_id");
