-- Phase 2: LDAP / Active Directory authentication — per-tenant directory
-- bind config. See packages/db/src/pg/schema.ts:ldapConfigs and
-- apps/web/src/server/services/ldap-config.ts.
--
-- One row per tenant; PK on `tenant_id` (the `_global` sentinel works as the
-- instance-wide fallback, same pattern as `email_config`). `bind_password`
-- and the optional `ca_pem` live in `secrets` as `enc:v1:…` ciphertext.

CREATE TABLE IF NOT EXISTS "ldap_configs" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"url" text NOT NULL,
	"bind_dn" text NOT NULL,
	"base_dn" text NOT NULL,
	"user_filter" text DEFAULT '(&(objectClass=person)(uid={{username}}))' NOT NULL,
	"group_filter" text,
	"attribute_map" jsonb DEFAULT '{"email":"mail","firstName":"givenName","lastName":"sn","groups":"memberOf"}'::jsonb NOT NULL,
	"default_role_id" text,
	"groups_to_roles" jsonb,
	"tls_options" jsonb,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"domain_match" jsonb,
	"rate_limit_per_minute" integer DEFAULT 10 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fk_ldap_configs_default_role_id_roles_id_fk" FOREIGN KEY ("default_role_id") REFERENCES "roles"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ldap_configs_tenant_idx" ON "ldap_configs" ("tenant_id");
