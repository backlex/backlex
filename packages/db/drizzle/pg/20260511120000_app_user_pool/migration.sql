-- Workspace end-user auth pool ("auth as a service").
--
-- Adds the `app_users` / `app_sessions` / `app_accounts` / `app_verifications`
-- tables that back a per-tenant identity pool for the end-users of apps built
-- on a workspace — separate from the control-plane `users` table the admin app
-- uses. Additive only: nothing reads or writes these tables yet (the per-tenant
-- better-auth router that does lands in a follow-up).

CREATE TABLE "app_users" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"image" text,
	"status" text DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_sessions" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_accounts" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_verifications" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_tenant_email_idx" ON "app_users" ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "app_users_tenant_idx" ON "app_users" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_sessions_token_idx" ON "app_sessions" ("token");--> statement-breakpoint
CREATE INDEX "app_sessions_user_idx" ON "app_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "app_sessions_tenant_idx" ON "app_sessions" ("tenant_id");--> statement-breakpoint
CREATE INDEX "app_accounts_user_idx" ON "app_accounts" ("user_id");--> statement-breakpoint
CREATE INDEX "app_accounts_tenant_idx" ON "app_accounts" ("tenant_id");--> statement-breakpoint
CREATE INDEX "app_verifications_tenant_idx" ON "app_verifications" ("tenant_id");--> statement-breakpoint
CREATE INDEX "app_verifications_identifier_idx" ON "app_verifications" ("identifier");--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_user_id_app_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_accounts" ADD CONSTRAINT "app_accounts_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_accounts" ADD CONSTRAINT "app_accounts_user_id_app_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_verifications" ADD CONSTRAINT "app_verifications_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
