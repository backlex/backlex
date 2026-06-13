-- Platform (control-plane / admin) SSO — instance-global SAML + LDAP for the
-- dashboard operator pool. Mirror of saml_providers / ldap_configs /
-- external_identities but WITHOUT tenant scoping: admin SSO is not
-- workspace-scoped. Identities land in `users` (not `app_users`). See
-- packages/db/src/pg/schema.ts:platformSamlProviders and
-- apps/web/src/server/services/platform-saml-providers.ts.
--
-- NOTE: platform_ldap_config is a singleton (id = 'singleton'). LDAP only runs
-- on Bun/Node self-host — on Cloudflare Workers buildLdapAdapter returns
-- undefined (see apps/web/src/server/lib/auth-select.ts).

CREATE TABLE IF NOT EXISTS "platform_saml_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"idp_template" text,
	"entity_id" text NOT NULL,
	"sso_url" text NOT NULL,
	"slo_url" text,
	"idp_cert_pem" text NOT NULL,
	"sp_entity_id" text NOT NULL,
	"attribute_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_role_id" text,
	"groups_to_roles" jsonb,
	"signature_algorithm" text DEFAULT 'sha256' NOT NULL,
	"want_signed_assertions" boolean DEFAULT true NOT NULL,
	"link_by_verified_email" boolean DEFAULT false NOT NULL,
	"name_id_format" text DEFAULT 'emailAddress' NOT NULL,
	"domain_match" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fk_platform_saml_providers_default_role_id_roles_id_fk" FOREIGN KEY ("default_role_id") REFERENCES "roles"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_saml_providers_slug_idx" ON "platform_saml_providers" ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_ldap_config" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
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
	CONSTRAINT "fk_platform_ldap_config_default_role_id_roles_id_fk" FOREIGN KEY ("default_role_id") REFERENCES "roles"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_external_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_type" text NOT NULL,
	"provider_id" text NOT NULL,
	"subject" text NOT NULL,
	"email_at_provision" text,
	"roles_from_groups" jsonb,
	"last_login_at" timestamp with time zone,
	"last_login_ip" text,
	"last_authn_context" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fk_platform_external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_external_identities_lookup_idx" ON "platform_external_identities" ("provider_type","provider_id","subject");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_external_identities_user_idx" ON "platform_external_identities" ("user_id");
