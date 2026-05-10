-- Seed system roles (admin/authenticated/public) into every tenant that
-- lacks them. Older workspaces were created before per-tenant role seeding
-- shipped — their `roles` rows live only in the default tenant after the
-- back-fill from 20260510160000_roles_apikeys_tenant_id, so any member
-- acting in those workspaces gets a 403 because `loadRolesForUser` returns
-- an empty set.
--
-- Also bind each tenant's owner/admin membership to the new admin role so
-- the workspace creator regains admin-level access. Idempotent.

INSERT INTO roles (id, tenant_id, name, description, admin, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  t.id,
  v.name,
  v.description,
  v.admin,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM tenants t
CROSS JOIN (
  SELECT 'admin' AS name, 'Full access; bypasses all permission checks.' AS description, 1 AS admin
  UNION ALL SELECT 'authenticated', 'Implicit role for any signed-in user.', 0
  UNION ALL SELECT 'public', 'Anonymous (no session) requests.', 0
) v
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.tenant_id = t.id AND r.name = v.name
);--> statement-breakpoint

INSERT INTO user_roles (user_id, role_id, created_at)
SELECT m.user_id, r.id, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM tenant_members m
JOIN roles r ON r.tenant_id = m.tenant_id AND r.name = 'admin'
WHERE m.user_id IS NOT NULL
  AND m.role IN ('owner','admin')
  AND NOT EXISTS (
    SELECT 1 FROM user_roles ur WHERE ur.user_id = m.user_id AND ur.role_id = r.id
  );
