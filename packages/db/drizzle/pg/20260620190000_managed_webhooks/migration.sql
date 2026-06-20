ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "last_failure_at" timestamptz;
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "disabled_reason" text;
