-- A website registered for tag-based measurement — SQLite/D1 twin. See the pg
-- migration for why the site id is public, why `require_known_origin` is not a
-- security boundary, and why `tz` ships unused.
--
-- Dialect differences: `jsonb` becomes `text` (json mode), `boolean` becomes
-- `integer` with 1/0 defaults, and timestamps are epoch-ms integers — the same
-- three substitutions every table in this schema makes.

CREATE TABLE IF NOT EXISTS `analytics_sites` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `name` text NOT NULL,
  `domain` text NOT NULL,
  `tz` text DEFAULT 'UTC' NOT NULL,
  `excluded_paths` text,
  `ignored_ips` text,
  `filter_bots` integer DEFAULT 1 NOT NULL,
  `require_known_origin` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
-- Every lookup is "this workspace's sites", and the collect route resolves a
-- reported origin to a site by host.
CREATE INDEX IF NOT EXISTS `analytics_sites_tenant_domain_idx` ON `analytics_sites` (`tenant_id`,`domain`);
