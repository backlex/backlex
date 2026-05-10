-- Tenant-scope roles and api_keys.
--
-- Adds `tenant_id` to `roles` and `api_keys`, back-fills existing rows with
-- the default tenant, and rewrites the unique index on roles from `(name)`
-- to `(tenant_id, name)` so each workspace owns its own role set.
--
-- Pre-existing system roles (admin/authenticated/public) land under the
-- default tenant. New tenants get their own copies seeded at creation time
-- by `ensureSystemRoles(ctx, tenantId)`.

ALTER TABLE `roles` ADD COLUMN `tenant_id` text;--> statement-breakpoint

UPDATE `roles`
SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'default' LIMIT 1)
WHERE `tenant_id` IS NULL;--> statement-breakpoint

DROP INDEX IF EXISTS `roles_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `roles_tenant_name_idx` ON `roles` (`tenant_id`, `name`);--> statement-breakpoint
CREATE INDEX `roles_tenant_idx` ON `roles` (`tenant_id`);--> statement-breakpoint

ALTER TABLE `api_keys` ADD COLUMN `tenant_id` text;--> statement-breakpoint

UPDATE `api_keys`
SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'default' LIMIT 1)
WHERE `tenant_id` IS NULL;--> statement-breakpoint

CREATE INDEX `api_keys_tenant_idx` ON `api_keys` (`tenant_id`);
