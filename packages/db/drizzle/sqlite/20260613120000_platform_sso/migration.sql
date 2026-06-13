-- Platform (control-plane / admin) SSO — instance-global SAML + LDAP for the
-- dashboard operator pool. Mirror of saml_providers / ldap_configs /
-- external_identities but WITHOUT tenant scoping. Identities land in `users`.
-- See packages/db/src/sqlite/schema.ts:platformSamlProviders and
-- apps/web/src/server/services/platform-saml-providers.ts.
--
-- platform_ldap_config is a singleton (id = 'singleton'). LDAP only runs on
-- Bun/Node self-host (not Cloudflare Workers — see lib/auth-select.ts).

CREATE TABLE `platform_saml_providers` (
	`id` text PRIMARY KEY,
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
	`domain_match` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_platform_saml_providers_default_role_id_roles_id_fk` FOREIGN KEY (`default_role_id`) REFERENCES `roles`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_saml_providers_slug_idx` ON `platform_saml_providers` (`slug`);
--> statement-breakpoint
CREATE TABLE `platform_ldap_config` (
	`id` text PRIMARY KEY DEFAULT 'singleton',
	`enabled` integer DEFAULT 0 NOT NULL,
	`url` text NOT NULL,
	`bind_dn` text NOT NULL,
	`base_dn` text NOT NULL,
	`user_filter` text DEFAULT '(&(objectClass=person)(uid={{username}}))' NOT NULL,
	`group_filter` text,
	`attribute_map` text DEFAULT '{"email":"mail","firstName":"givenName","lastName":"sn","groups":"memberOf"}' NOT NULL,
	`default_role_id` text,
	`groups_to_roles` text,
	`tls_options` text,
	`secrets` text DEFAULT '{}' NOT NULL,
	`domain_match` text,
	`rate_limit_per_minute` integer DEFAULT 10 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_platform_ldap_config_default_role_id_roles_id_fk` FOREIGN KEY (`default_role_id`) REFERENCES `roles`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `platform_external_identities` (
	`id` text PRIMARY KEY,
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
	CONSTRAINT `fk_platform_external_identities_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_external_identities_lookup_idx` ON `platform_external_identities` (`provider_type`,`provider_id`,`subject`);
--> statement-breakpoint
CREATE INDEX `platform_external_identities_user_idx` ON `platform_external_identities` (`user_id`);
