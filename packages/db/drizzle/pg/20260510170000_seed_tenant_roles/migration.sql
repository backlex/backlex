-- Mirror of the SQLite seed_tenant_roles migration. Seeds admin/authenticated/
-- public into every tenant that lacks them and binds each workspace's
-- owner/admin members to the new admin role. Idempotent.

INSERT INTO "roles" ("id", "tenant_id", "name", "description", "admin")
SELECT
  gen_random_uuid()::text,
  t."id",
  v."name",
  v."description",
  v."admin"
FROM "tenants" t
CROSS JOIN (
  VALUES
    ('admin'::text, 'Full access; bypasses all permission checks.'::text, true),
    ('authenticated', 'Implicit role for any signed-in user.', false),
    ('public', 'Anonymous (no session) requests.', false)
) AS v("name", "description", "admin")
WHERE NOT EXISTS (
  SELECT 1 FROM "roles" r WHERE r."tenant_id" = t."id" AND r."name" = v."name"
);--> statement-breakpoint

INSERT INTO "user_roles" ("user_id", "role_id")
SELECT m."user_id", r."id"
FROM "tenant_members" m
JOIN "roles" r ON r."tenant_id" = m."tenant_id" AND r."name" = 'admin'
WHERE m."user_id" IS NOT NULL
  AND m."role" IN ('owner','admin')
  AND NOT EXISTS (
    SELECT 1 FROM "user_roles" ur WHERE ur."user_id" = m."user_id" AND ur."role_id" = r."id"
  );
