-- Product analytics + crash reporting (#22): the tracked-event stream plus the
-- deduplicated error groups and their captured occurrences. All three are
-- high-volume, FK-free and pruned by retention. `analytics_events.day` is the
-- denormalized UTC day of `ts` so funnel/retention cohorts group without
-- dialect-specific date math. See
-- packages/db/drizzle/pg/20260727090000_product_analytics for the twin.

CREATE TABLE IF NOT EXISTS `analytics_events` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `name` text NOT NULL,
  `distinct_id` text NOT NULL,
  `user_id` text,
  `session_id` text,
  `props` text,
  `path` text,
  `referrer` text,
  `source` text,
  `release` text,
  `country` text,
  `ts` integer NOT NULL,
  `day` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_events_tenant_ts_idx` ON `analytics_events` (`tenant_id`,`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_events_tenant_name_ts_idx` ON `analytics_events` (`tenant_id`,`name`,`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_events_tenant_distinct_idx` ON `analytics_events` (`tenant_id`,`distinct_id`,`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_events_tenant_day_idx` ON `analytics_events` (`tenant_id`,`day`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `error_groups` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `fingerprint` text NOT NULL,
  `type` text DEFAULT 'Error' NOT NULL,
  `message` text NOT NULL,
  `culprit` text,
  `level` text DEFAULT 'error' NOT NULL,
  `platform` text,
  `release` text,
  `status` text DEFAULT 'open' NOT NULL,
  `events` integer DEFAULT 0 NOT NULL,
  `first_seen` integer NOT NULL,
  `last_seen` integer NOT NULL,
  `resolved_at` integer,
  `resolved_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `error_groups_tenant_last_seen_idx` ON `error_groups` (`tenant_id`,`last_seen`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `error_groups_tenant_status_idx` ON `error_groups` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `error_events` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `group_id` text NOT NULL,
  `type` text DEFAULT 'Error' NOT NULL,
  `message` text NOT NULL,
  `stack` text,
  `level` text DEFAULT 'error' NOT NULL,
  `platform` text,
  `release` text,
  `url` text,
  `user_id` text,
  `distinct_id` text,
  `session_id` text,
  `context` text,
  `ts` integer NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `error_events_group_ts_idx` ON `error_events` (`group_id`,`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `error_events_tenant_ts_idx` ON `error_events` (`tenant_id`,`ts`);
