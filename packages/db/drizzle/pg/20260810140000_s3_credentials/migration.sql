-- S3-compatible endpoint credentials.
--
-- `secret_key` holds an encrypted secret, not a digest, and that is a
-- deliberate exception to how every other credential in this schema is stored.
-- SigV4 is not a bearer scheme: the client derives a signing key from the
-- secret and signs with it, so the server must derive the same key to verify.
-- A hash cannot. The value is AES-GCM encrypted with the deployment's
-- AUTH_SECRET, which protects a database dump and nothing beyond it.
--
-- `access_key_id` is unique instance-wide because a SigV4 request carries no
-- workspace header — it is the only thing that can name the workspace.

CREATE TABLE IF NOT EXISTS "s3_credentials" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "access_key_id" text NOT NULL,
  "secret_key" text NOT NULL,
  "prefix" text,
  "read_only" boolean DEFAULT false NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "s3_credentials_akid_idx"
  ON "s3_credentials" ("access_key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s3_credentials_tenant_idx"
  ON "s3_credentials" ("tenant_id");
