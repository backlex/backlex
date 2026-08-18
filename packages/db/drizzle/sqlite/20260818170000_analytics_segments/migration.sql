-- A saved analytics filter — SQLite/D1 twin. See the pg migration for why the
-- definition is stored opaque and re-validated on every read.
--
-- Dialect differences: `jsonb` becomes `text` (json mode) and timestamps are
-- epoch-ms integers.

CREATE TABLE IF NOT EXISTS `analytics_segments` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `site_id` text,
  `name` text NOT NULL,
  `definition` text,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_segments_tenant_idx` ON `analytics_segments` (`tenant_id`,`site_id`);
