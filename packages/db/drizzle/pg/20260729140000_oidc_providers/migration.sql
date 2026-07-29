-- Generic OIDC / OAuth2 identity providers, per workspace. The generic twin of
-- `saml_providers`: one row per IdP so Okta / Auth0 / Keycloak / Entra /
-- Authentik / GitLab all run the same code path instead of one hand-written
-- provider each. `client_secret_enc` is AES-256-GCM ciphertext, never plaintext.

CREATE TABLE IF NOT EXISTS "oidc_providers" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "client_id" text NOT NULL,
  "client_secret_enc" text NOT NULL,
  "discovery_url" text,
  "authorization_url" text,
  "token_url" text,
  "user_info_url" text,
  "scopes" jsonb DEFAULT '["openid","profile","email"]'::jsonb NOT NULL,
  "pkce" boolean DEFAULT true NOT NULL,
  "email_claim" text,
  "groups_claim" text,
  "default_role_id" text REFERENCES "roles"("id") ON DELETE SET NULL,
  "groups_to_roles" jsonb,
  "link_by_verified_email" boolean DEFAULT false NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_providers_tenant_slug_idx"
  ON "oidc_providers" ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_providers_tenant_idx"
  ON "oidc_providers" ("tenant_id");
