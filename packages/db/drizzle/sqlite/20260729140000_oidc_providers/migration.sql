-- Generic OIDC / OAuth2 identity providers — SQLite/D1 twin of the pg
-- migration. See it for the why. Timestamps are epoch-ms integers, booleans
-- are 0/1, and JSON columns are text.

CREATE TABLE IF NOT EXISTS `oidc_providers` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `client_id` text NOT NULL,
  `client_secret_enc` text NOT NULL,
  `discovery_url` text,
  `authorization_url` text,
  `token_url` text,
  `user_info_url` text,
  `scopes` text DEFAULT '["openid","profile","email"]' NOT NULL,
  `pkce` integer DEFAULT 1 NOT NULL,
  `email_claim` text,
  `groups_claim` text,
  `default_role_id` text REFERENCES `roles`(`id`) ON DELETE SET NULL,
  `groups_to_roles` text,
  `link_by_verified_email` integer DEFAULT 0 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `oidc_providers_tenant_slug_idx`
  ON `oidc_providers` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oidc_providers_tenant_idx`
  ON `oidc_providers` (`tenant_id`);
