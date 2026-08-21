-- Every distinct artifact a site's consent policy has compiled to — SQLite/D1
-- twin. See the pg migration for why this is content-addressed rather than
-- counter-versioned, and why there is no foreign key.
--
-- Dialect differences: `jsonb` becomes `text` (json mode) and the timestamp is
-- an epoch-ms integer with no default — the application supplies it, as
-- everywhere else in this schema.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`. Replay is absorbed one layer up:
-- `auto-migrate.ts`'s ALREADY_EXISTS_RE matches "duplicate column" down the
-- Error.cause chain, which is the same mechanism every other column add in
-- this directory relies on. Do not rewrite it as a table rebuild.

CREATE TABLE IF NOT EXISTS `consent_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `site_id` text NOT NULL,
  `hash` text NOT NULL,
  `snapshot` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `consent_versions_site_hash_idx` ON `consent_versions` (`site_id`,`hash`);--> statement-breakpoint
ALTER TABLE `consent_policies` ADD COLUMN `artifact_hash` text;
