-- Phase 1: SAML 2.0 SSO — per-tenant IdP configuration + federated identity
-- audit trail. See packages/db/src/sqlite/schema.ts:samlProviders /
-- externalIdentities and apps/web/src/server/services/saml-providers.ts.
--
-- `saml_providers` holds the IdP config (cert PEM is `enc:v1:…` ciphertext).
-- `external_identities` links a workspace user (or platform user) to the
-- IdP-asserted subject (`plane` decides which user pool `user_id` references).

CREATE TABLE `saml_providers` (
	`id` text PRIMARY KEY,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`idp_template` text,
	`entity_id` text NOT NULL,
	`sso_url` text NOT NULL,
	`slo_url` text,
	`idp_cert_pem` text NOT NULL,
	`sp_entity_id` text NOT NULL,
	`attribute_map` text DEFAULT '{}' NOT NULL,
	`default_role_id` text,
	`groups_to_roles` text,
	`signature_algorithm` text DEFAULT 'sha256' NOT NULL,
	`want_signed_assertions` integer DEFAULT 1 NOT NULL,
	`link_by_verified_email` integer DEFAULT 0 NOT NULL,
	`name_id_format` text DEFAULT 'emailAddress' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_saml_providers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_saml_providers_default_role_id_roles_id_fk` FOREIGN KEY (`default_role_id`) REFERENCES `roles`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_providers_tenant_slug_idx` ON `saml_providers` (`tenant_id`,`slug`);
--> statement-breakpoint
CREATE INDEX `saml_providers_tenant_idx` ON `saml_providers` (`tenant_id`);
--> statement-breakpoint
CREATE TABLE `external_identities` (
	`id` text PRIMARY KEY,
	`tenant_id` text NOT NULL,
	`plane` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`email_at_provision` text,
	`roles_from_groups` text,
	`last_login_at` integer,
	`last_login_ip` text,
	`last_authn_context` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_external_identities_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_lookup_idx` ON `external_identities` (`tenant_id`,`provider_type`,`provider_id`,`subject`);
--> statement-breakpoint
CREATE INDEX `external_identities_user_idx` ON `external_identities` (`plane`,`user_id`);
