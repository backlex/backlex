CREATE INDEX `activity_tenant_created_idx` ON `activity` (`tenant_id`,`created_at`);
--> statement-breakpoint
-- The single-column (tenant_id) index is now a redundant leftmost prefix of
-- the composite above — drop it so activity writes don't maintain both.
DROP INDEX IF EXISTS `activity_tenant_idx`;
