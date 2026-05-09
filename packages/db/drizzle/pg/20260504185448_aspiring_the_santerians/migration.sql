CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY,
	"prefix" text NOT NULL,
	"hashed_key" text NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hashed_idx" ON "api_keys" ("hashed_key");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" ("user_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;