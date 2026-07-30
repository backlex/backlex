-- SCIM 2.0 provisioning endpoint, one row per workspace. SSO provisions a user
-- on first login; SCIM lets the IdP create and DEPROVISION on its own schedule,
-- which is what enterprise directory sync actually means. The bearer token is
-- stored as a SHA-256 hash (same as api_keys) and shown once.

CREATE TABLE IF NOT EXISTS "scim_config" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "token_prefix" text NOT NULL,
  "default_role_id" text REFERENCES "roles"("id") ON DELETE SET NULL,
  "last_request_at" timestamp with time zone,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_config_tenant_idx" ON "scim_config" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_config_token_idx" ON "scim_config" ("token_hash");
