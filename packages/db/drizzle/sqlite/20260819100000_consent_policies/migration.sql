-- The cookie-consent policy a site publishes — SQLite/D1 twin.
--
-- See the pg migration for why `site_id` is the primary key and why
-- `undecided_behaviour` / `tracker_category` carry no default.
--
-- Dialect differences: `jsonb` becomes `text` (json mode), `boolean` becomes an
-- integer 0/1, and timestamps are epoch-ms integers with no default — the
-- application supplies them, as everywhere else in this schema.

CREATE TABLE IF NOT EXISTS `consent_policies` (
  `site_id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `categories_offered` text,
  `undecided_behaviour` text NOT NULL,
  `tracker_category` text NOT NULL,
  `wording` text,
  `default_locale` text DEFAULT 'en' NOT NULL,
  `policy_url` text,
  `position` text DEFAULT 'bottom' NOT NULL,
  `theme` text,
  `cookie_max_age_days` integer DEFAULT 180 NOT NULL,
  `enabled` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `consent_policies_tenant_idx` ON `consent_policies` (`tenant_id`);
