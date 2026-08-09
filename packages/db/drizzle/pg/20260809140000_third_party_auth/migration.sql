-- External issuers whose JWTs a workspace accepts as they are — Clerk, Auth0,
-- Firebase Auth, AWS Cognito, WorkOS.
--
-- This is NOT `oidc_providers`, and the difference is the whole reason the
-- table exists. `oidc_providers` makes backlex an OAuth *client*: redirect the
-- user to the IdP, exchange a code, mint our own session. That needs a client
-- secret and costs the end-user a second login. An app already running on
-- Clerk does not want either — it holds a Clerk token and wants to call us
-- with it. Here we only verify the signature against the issuer's published
-- JWKS and map the subject onto an `app_users` row, so nobody migrates a user
-- table to adopt backlex.
--
-- `issuer` is unique instance-wide rather than per tenant on purpose: a request
-- carrying one of these tokens has no session row and no workspace header to
-- lean on, so the `iss` claim is the only thing that can name the workspace.
-- Real issuers are already customer-specific
-- (`https://<x>.clerk.accounts.dev`, `https://securetoken.google.com/<project>`,
-- `https://<tenant>.auth0.com/`), so the constraint costs nothing in practice.
--
-- Claim-mapping columns intentionally repeat the names and defaults used by
-- `oidc_providers`: both feed the same `provisionAppUser`, and two spellings of
-- "which claim holds the email" is exactly how the two paths would drift.
--
-- Re-runnable: every statement is IF NOT EXISTS, so the boot runner replaying
-- this file is a no-op.

CREATE TABLE IF NOT EXISTS "third_party_auth_providers" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "issuer" text NOT NULL,
  "jwks_url" text NOT NULL,
  "discovery_url" text,
  "audience" text,
  "subject_claim" text DEFAULT 'sub' NOT NULL,
  "email_claim" text DEFAULT 'email' NOT NULL,
  "name_claim" text,
  "groups_claim" text,
  "groups_to_roles" jsonb,
  "default_role_id" text REFERENCES "roles"("id") ON DELETE SET NULL,
  "link_by_verified_email" boolean DEFAULT false NOT NULL,
  "auto_provision" boolean DEFAULT true NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "third_party_auth_tenant_slug_idx"
  ON "third_party_auth_providers" ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "third_party_auth_issuer_idx"
  ON "third_party_auth_providers" ("issuer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "third_party_auth_tenant_idx"
  ON "third_party_auth_providers" ("tenant_id");
