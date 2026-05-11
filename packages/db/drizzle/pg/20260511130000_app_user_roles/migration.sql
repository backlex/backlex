-- Role assignments for workspace end-users (the app_users pool). Parallel to
-- user_roles but keyed by app_users.id. Additive only.

CREATE TABLE "app_user_roles" (
	"app_user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_roles_pk" ON "app_user_roles" ("app_user_id","role_id");--> statement-breakpoint
CREATE INDEX "app_user_roles_role_idx" ON "app_user_roles" ("role_id");--> statement-breakpoint
ALTER TABLE "app_user_roles" ADD CONSTRAINT "app_user_roles_app_user_id_app_users_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_user_roles" ADD CONSTRAINT "app_user_roles_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE;
