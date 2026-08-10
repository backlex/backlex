-- Child mappings on a source sync — SQLite/D1 twin. See the pg migration for
-- why a flat record cannot describe a marketplace order.

ALTER TABLE `integration_syncs` ADD COLUMN `child_mappings` text DEFAULT '{}' NOT NULL;
