-- A visitor's decision, and what it was a decision about — SQLite/D1 twin.
-- See the pg migration for the append-only argument, why `ip_hash` is a salted
-- hash rather than an address, why `hash_grade` has three values, and why there
-- is no foreign key.
--
-- Dialect differences: `jsonb` becomes `text` (json mode) and the timestamp is
-- an epoch-ms integer with no default — the application supplies it, as
-- everywhere else in this schema.

CREATE TABLE IF NOT EXISTS `consent_records` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `site_id` text NOT NULL,
  `subject_id` text NOT NULL,
  `policy_hash` text,
  `version_id` text,
  `hash_grade` text NOT NULL,
  `decision` text NOT NULL,
  `grants` text NOT NULL,
  `source` text NOT NULL,
  `locale` text,
  `country` text,
  `ip_hash` text,
  `user_agent` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `consent_records_site_subject_idx` ON `consent_records` (`site_id`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `consent_records_tenant_subject_idx` ON `consent_records` (`tenant_id`,`subject_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `consent_records_tenant_created_idx` ON `consent_records` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `consent_records_created_idx` ON `consent_records` (`created_at`);
