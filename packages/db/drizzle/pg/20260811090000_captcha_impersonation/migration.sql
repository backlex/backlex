-- Captcha configuration and audited impersonation.
--
-- `auth_config.captcha` holds the provider, the site key and an ENCRYPTED
-- secret. It is a column rather than another key under `providers` because a
-- captcha is not a way to sign in — it gates the ones that are.
--
-- `impersonations` is a row every impersonated request re-reads, not a
-- self-contained token. A signed token alone cannot be ended early, and the
-- record of who acted as whom would exist only if the operator chose to write
-- it down. `reason` is NOT NULL for the same reason.

ALTER TABLE "auth_config" ADD COLUMN IF NOT EXISTS "captcha" jsonb;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "impersonations" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "actor_user_id" text NOT NULL,
  "actor_email" text,
  "subject_user_id" text NOT NULL,
  "subject_email" text,
  "reason" text NOT NULL,
  "read_only" boolean DEFAULT true NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "ended_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "impersonations_tenant_idx"
  ON "impersonations" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "impersonations_subject_idx"
  ON "impersonations" ("subject_user_id");--> statement-breakpoint

-- The operator behind an impersonated request. A column, not a payload key:
-- "what did support do while acting as a customer" is a query, and a JSON grep
-- over every activity row is not one. `user_id` stays the SUBJECT's.
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "impersonated_by" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_impersonated_idx"
  ON "activity" ("impersonated_by");
