-- Per-workspace collections (SQLite/D1 mirror of the PG migration).
--
-- SQLite cannot ALTER PRIMARY KEY in place, so we follow the standard
-- "create new table, copy rows, swap names" pattern after backfilling the
-- new columns on the existing table.

ALTER TABLE `collections` ADD COLUMN `id` text;--> statement-breakpoint
ALTER TABLE `collections` ADD COLUMN `physical_table` text;--> statement-breakpoint

UPDATE `collections` SET `id` = lower(hex(randomblob(16))) WHERE `id` IS NULL;--> statement-breakpoint

UPDATE `collections`
SET `tenant_id` = COALESCE(
  (
    SELECT u.`active_tenant_id`
    FROM `users` u
    JOIN `user_roles` ur ON ur.`user_id` = u.`id`
    JOIN `roles` r ON r.`id` = ur.`role_id`
    WHERE r.`admin` = 1 AND u.`active_tenant_id` IS NOT NULL
    ORDER BY u.`created_at` ASC
    LIMIT 1
  ),
  (SELECT `id` FROM `tenants` ORDER BY `created_at` ASC LIMIT 1)
)
WHERE `tenant_id` IS NULL;--> statement-breakpoint

UPDATE `collections` SET `physical_table` = 'c_' || `slug` WHERE `physical_table` IS NULL;--> statement-breakpoint

PRAGMA foreign_keys = OFF;--> statement-breakpoint

CREATE TABLE `__new_collections` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `tenant_id` text NOT NULL,
  `physical_table` text NOT NULL,
  `singular` text,
  `plural` text,
  `note` text,
  `display_template` text,
  `fields` text NOT NULL,
  `owner_scoped` integer DEFAULT 0 NOT NULL,
  `tenant_scoped` integer DEFAULT 1 NOT NULL,
  `versioned` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `fk_collections_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE
);--> statement-breakpoint

INSERT INTO `__new_collections` (
  `id`, `slug`, `tenant_id`, `physical_table`,
  `singular`, `plural`, `note`, `display_template`, `fields`,
  `owner_scoped`, `tenant_scoped`, `versioned`, `created_at`, `updated_at`
)
SELECT
  `id`, `slug`, `tenant_id`, `physical_table`,
  `singular`, `plural`, `note`, `display_template`, `fields`,
  `owner_scoped`, `tenant_scoped`, `versioned`, `created_at`, `updated_at`
FROM `collections`;--> statement-breakpoint

DROP TABLE `collections`;--> statement-breakpoint
ALTER TABLE `__new_collections` RENAME TO `collections`;--> statement-breakpoint

CREATE UNIQUE INDEX `collections_tenant_slug_idx` ON `collections` (`tenant_id`, `slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_physical_table_idx` ON `collections` (`physical_table`);--> statement-breakpoint

PRAGMA foreign_keys = ON;
