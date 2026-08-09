-- External issuers whose JWTs a workspace accepts as they are — SQLite/D1 twin
-- of the pg migration. See it for the why, including why `issuer` is unique
-- instance-wide rather than per tenant. Timestamps are epoch-ms integers,
-- booleans are 0/1, and JSON columns are text.

CREATE TABLE IF NOT EXISTS `third_party_auth_providers` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `issuer` text NOT NULL,
  `jwks_url` text NOT NULL,
  `discovery_url` text,
  `audience` text,
  `subject_claim` text DEFAULT 'sub' NOT NULL,
  `email_claim` text DEFAULT 'email' NOT NULL,
  `name_claim` text,
  `groups_claim` text,
  `groups_to_roles` text,
  `default_role_id` text REFERENCES `roles`(`id`) ON DELETE SET NULL,
  `link_by_verified_email` integer DEFAULT 0 NOT NULL,
  `auto_provision` integer DEFAULT 1 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `third_party_auth_tenant_slug_idx`
  ON `third_party_auth_providers` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `third_party_auth_issuer_idx`
  ON `third_party_auth_providers` (`issuer`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `third_party_auth_tenant_idx`
  ON `third_party_auth_providers` (`tenant_id`);
