-- PG baseline — backfills tables that the SQLite migration chain creates
-- but were never mirrored into the PG chain. Runs FIRST (timestamp predates
-- the existing chain) so subsequent migrations that reference `tenants`,
-- `tenant_members`, etc. find them. See packages/db/src/pg/schema.ts for the
-- source-of-truth column definitions; this file mirrors the SQLite migrations
-- 20260506045054 (comments + webhook_deliveries), 20260506051054
-- (notifications), 20260509212015 (tenants + tenant_members + app_settings +
-- auth_config + backups + i18n_strings + saved_panels) and 20260510000855
-- (tenant_members.last_seen_at) into a single up-front baseline.
--
-- Column-level back-fills that target tables created by the existing chain
-- (e.g. `users.active_tenant_id`, `collections.tenant_id`) live in
-- `20260509000000_pg_chain_columns` — that one slots in AFTER the chain
-- tables exist but BEFORE `20260510120000_per_workspace_collections` reads
-- them.

CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"project" text DEFAULT 'default' NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"env" text DEFAULT 'development' NOT NULL,
	"mark" text,
	"color" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" ("slug");
--> statement-breakpoint

CREATE TABLE "tenant_members" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" text,
	"invited_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"invite_token" text,
	"invite_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_members_tenant_email_idx" ON "tenant_members" ("tenant_id","email");
--> statement-breakpoint
CREATE INDEX "tenant_members_user_idx" ON "tenant_members" ("user_id");
--> statement-breakpoint
CREATE INDEX "tenant_members_invite_token_idx" ON "tenant_members" ("invite_token");
--> statement-breakpoint

CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_item_idx" ON "comments" ("collection","item_id");
--> statement-breakpoint
CREATE INDEX "comments_user_idx" ON "comments" ("user_id");
--> statement-breakpoint
CREATE INDEX "comments_tenant_idx" ON "comments" ("tenant_id");
--> statement-breakpoint

CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"user_id" text,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"flow_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" ("user_id");
--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" ("user_id","read_at");
--> statement-breakpoint
CREATE INDEX "notifications_tenant_idx" ON "notifications" ("tenant_id");
--> statement-breakpoint

CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event" text NOT NULL,
	"status" integer NOT NULL,
	"ms" integer NOT NULL,
	"response_body" text,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_hook_idx" ON "webhook_deliveries" ("webhook_id");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_at_idx" ON "webhook_deliveries" ("delivered_at");
--> statement-breakpoint

CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"key" text NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_settings_unique_idx" ON "app_settings" ("tenant_id","key");
--> statement-breakpoint

CREATE TABLE "auth_config" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"providers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"session_lifetime" text DEFAULT '30d' NOT NULL,
	"redirect_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "backups" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"kind" text DEFAULT 'manual' NOT NULL,
	"label" text,
	"storage_key" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"table_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "backups_tenant_idx" ON "backups" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "backups_created_idx" ON "backups" ("created_at");
--> statement-breakpoint

CREATE TABLE "i18n_strings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"key" text NOT NULL,
	"locale" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "i18n_strings_unique_idx" ON "i18n_strings" ("tenant_id","key","locale");
--> statement-breakpoint
CREATE INDEX "i18n_strings_locale_idx" ON "i18n_strings" ("locale");
--> statement-breakpoint

CREATE TABLE "saved_panels" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'sql' NOT NULL,
	"sql" text,
	"viz" text DEFAULT 'sparkline' NOT NULL,
	"config" jsonb,
	"layout" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "saved_panels_tenant_idx" ON "saved_panels" ("tenant_id");
