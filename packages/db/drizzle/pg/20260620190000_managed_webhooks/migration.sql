ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "last_failure_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "disabled_reason" text;
