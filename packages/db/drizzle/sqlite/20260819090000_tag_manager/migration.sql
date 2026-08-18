-- Tag manager — SQLite/D1 twin. See the pg migration for why the site is the
-- container, why the draft tables are separate from `tag_versions`, why
-- `trigger_ids` is a JSON array, and why `allow_custom_code` defaults to off.
--
-- Three dialect differences, all forced and all the same substitutions every
-- table in this schema makes:
--
-- 1. `jsonb` becomes `text` (json mode).
-- 2. `boolean` becomes `integer` with 1/0 defaults.
-- 3. Timestamps are epoch-ms integers with no DEFAULT — the application sets
--    them, because SQLite has no `now()` that returns milliseconds.
--
-- And one that is worth stating outright: **SQLite does not accept
-- `IF NOT EXISTS` on ADD COLUMN.** A replay therefore raises "duplicate column
-- name", which `auto-migrate.ts` tolerates for exactly this statement shape
-- (`packages/db/src/auto-migrate.ts:145`). The CREATE statements below DO take
-- `IF NOT EXISTS`, so they are genuine no-ops on replay.
--
-- `allow_custom_code` is added NOT NULL with a DEFAULT, which SQLite allows on
-- ADD COLUMN precisely because the default backfills every existing row — every
-- site that predates this migration comes out with custom code OFF, which is
-- the answer we want for a capability nobody asked for yet.

ALTER TABLE `analytics_sites` ADD COLUMN `allow_custom_code` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analytics_sites` ADD COLUMN `published_version` integer;--> statement-breakpoint
ALTER TABLE `analytics_sites` ADD COLUMN `published_version_id` text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `tag_variables` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `site_id` text NOT NULL,
  `key` text NOT NULL,
  `name` text NOT NULL,
  `kind` text DEFAULT 'constant' NOT NULL,
  `config` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tag_variables_site_idx` ON `tag_variables` (`site_id`);--> statement-breakpoint
-- One key per site: `{{page_type}}` has to resolve to exactly one definition.
CREATE UNIQUE INDEX IF NOT EXISTS `tag_variables_site_key_idx` ON `tag_variables` (`site_id`,`key`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `tag_triggers` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `site_id` text NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `config` text,
  `condition` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tag_triggers_site_idx` ON `tag_triggers` (`site_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `tag_definitions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `site_id` text NOT NULL,
  `name` text NOT NULL,
  `kind` text DEFAULT 'template' NOT NULL,
  `template_id` text,
  `params` text,
  `trigger_ids` text,
  `blocking_trigger_ids` text,
  `consent_category` text DEFAULT 'marketing' NOT NULL,
  `fire_rule` text DEFAULT 'always' NOT NULL,
  `priority` integer DEFAULT 0 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_by` text,
  `updated_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tag_definitions_site_idx` ON `tag_definitions` (`site_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `tag_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `site_id` text NOT NULL,
  `version` integer NOT NULL,
  `note` text,
  `snapshot` text NOT NULL,
  `hash` text NOT NULL,
  `created_by` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
-- Version numbers are monotonic per site and are what a rollback names, so two
-- rows claiming the same number is a corruption the database should refuse.
CREATE UNIQUE INDEX IF NOT EXISTS `tag_versions_site_version_idx` ON `tag_versions` (`site_id`,`version`);
