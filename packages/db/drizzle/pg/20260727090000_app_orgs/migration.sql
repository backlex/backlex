-- App-plane organizations ("teams") — a second grouping level inside one
-- workspace, for the B2B customers of the app built on it.
--
--  * `app_orgs`             — the org itself, unique by (tenant, slug).
--  * `app_org_members`      — who belongs, with the membership role
--                             (owner/admin/member) that governs org admin.
--  * `app_org_member_roles` — workspace `roles` bound to a member *within one
--                             org*; the org-scoped sibling of `app_user_roles`.
--  * `app_org_invites`      — pending + accepted invitations. A real table (not
--                             a hidden `app_verifications` row like the
--                             workspace-level invite) because "who's still
--                             pending?" has to be listable.
--  * `app_sessions.active_org_id` — which org a session is acting in, so the
--                             permission DSL can resolve `$org.id` without the
--                             client re-sending a header on every call.
--
-- Additive only: an instance with no orgs behaves exactly as before.

CREATE TABLE IF NOT EXISTS "app_orgs" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "image" text,
  "metadata" jsonb,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_orgs_tenant_slug_idx" ON "app_orgs" ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_orgs_tenant_idx" ON "app_orgs" ("tenant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_org_members" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "org_id" text NOT NULL,
  "app_user_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_org_members_pk" ON "app_org_members" ("org_id","app_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_org_members_user_idx" ON "app_org_members" ("app_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_org_members_tenant_idx" ON "app_org_members" ("tenant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_org_member_roles" (
  "org_id" text NOT NULL,
  "app_user_id" text NOT NULL,
  "role_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_org_member_roles_pk" ON "app_org_member_roles" ("org_id","app_user_id","role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_org_member_roles_role_idx" ON "app_org_member_roles" ("role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_org_member_roles_user_idx" ON "app_org_member_roles" ("app_user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_org_invites" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "org_id" text NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "role_ids" jsonb,
  "token" text NOT NULL,
  "invited_by" text,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_org_invites_token_idx" ON "app_org_invites" ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_org_invites_org_idx" ON "app_org_invites" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_org_invites_email_idx" ON "app_org_invites" ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_org_invites_tenant_idx" ON "app_org_invites" ("tenant_id");--> statement-breakpoint

ALTER TABLE "app_sessions" ADD COLUMN IF NOT EXISTS "active_org_id" text;
