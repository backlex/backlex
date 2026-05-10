-- Tenant-scope storage folders.
--
-- Mirrors the PG migration: adds `tenant_id` to `folders`, back-fills with
-- the default tenant, and indexes the column.

ALTER TABLE `folders` ADD COLUMN `tenant_id` text;--> statement-breakpoint

UPDATE `folders`
SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'default' LIMIT 1)
WHERE `tenant_id` IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `folders_tenant_idx` ON `folders` (`tenant_id`);
