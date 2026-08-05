-- Pinned KPIs — SQLite/D1 twin of the pg migration, where the reasoning is
-- written out in full.
--
-- The short version: `pin_to` is the collection whose ITEM PAGE the tile
-- belongs on, which is not the collection the KPI aggregates — "revenue per
-- product" sums order lines and belongs on a product. `pin_field` is the
-- relation column on the KPI's own collection pointing back at that row, so
-- the server never has to guess which relation the pin meant.
ALTER TABLE `kpis` ADD COLUMN `pin_to` text;
--> statement-breakpoint
ALTER TABLE `kpis` ADD COLUMN `pin_field` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `kpis_pin_idx` ON `kpis` (`tenant_id`, `pin_to`);
