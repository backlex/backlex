-- Phase 2: LDAP / Active Directory authentication — per-tenant directory
-- bind config. See packages/db/src/sqlite/schema.ts:ldapConfigs and
-- apps/web/src/server/services/ldap-config.ts.

CREATE TABLE `ldap_configs` (
	`tenant_id` text PRIMARY KEY,
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
	CONSTRAINT `fk_ldap_configs_default_role_id_roles_id_fk` FOREIGN KEY (`default_role_id`) REFERENCES `roles`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `ldap_configs_tenant_idx` ON `ldap_configs` (`tenant_id`);
