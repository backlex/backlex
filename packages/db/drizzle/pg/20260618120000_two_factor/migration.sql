ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "twoFactor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "two_factor_user_idx" ON "twoFactor" ("user_id");--> statement-breakpoint
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
