-- Availability and booking. SQLite/D1 twin of the pg migration, where the
-- design reasoning is written out in full.
--
-- The short version: a collection can hold a booking, and
-- `booking_resources.mirror_collection` is there so that it does. What a
-- collection cannot do is refuse the SECOND write for the same instant. The
-- overlap guard needs one table, one index and one ordering rule every writer
-- agrees on — on a store with no row locks. So the ledger is authoritative for
-- the SLOT and the mirrored row is authoritative for everything else.
CREATE TABLE IF NOT EXISTS `booking_resources` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  -- The zone the RULES are written in. "Mondays 09:00" does not move when the
  -- clocks do; the instant it names does.
  `time_zone` text DEFAULT 'UTC' NOT NULL,
  `slot_minutes` integer DEFAULT 30 NOT NULL,
  `step_minutes` integer,
  `capacity` integer DEFAULT 1 NOT NULL,
  `buffer_before_minutes` integer DEFAULT 0 NOT NULL,
  `buffer_after_minutes` integer DEFAULT 0 NOT NULL,
  `lead_minutes` integer DEFAULT 0 NOT NULL,
  `horizon_days` integer DEFAULT 60 NOT NULL,
  `hold_minutes` integer DEFAULT 10 NOT NULL,
  `questions` text,
  `mirror_collection` text,
  `mirror_field_map` text,
  `token_hash` text NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `confirmation_message` text,
  `notify_emails` text,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `booking_resources_tenant_key_idx`
  ON `booking_resources` (`tenant_id`, `key`);
--> statement-breakpoint
-- Only the SHA-256 of the public page token is stored; it is shown once on
-- creation, exactly like a form's.
CREATE UNIQUE INDEX IF NOT EXISTS `booking_resources_token_idx`
  ON `booking_resources` (`token_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `booking_resources_tenant_idx`
  ON `booking_resources` (`tenant_id`);
--> statement-breakpoint
-- One line of an opening pattern, or one exception to it. Minutes from LOCAL
-- midnight, never instants; `starts_on`/`ends_on` are TEXT calendar dates so a
-- rule bound cannot shift with an offset. A shift crossing midnight is two
-- rules, so no interval has to be read as "wraps around".
CREATE TABLE IF NOT EXISTS `booking_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `resource_id` text NOT NULL,
  `kind` text DEFAULT 'open' NOT NULL,
  -- 0=Sunday … 6=Saturday, or NULL for "every day inside the date range".
  `weekday` integer,
  `start_minute` integer NOT NULL,
  `end_minute` integer NOT NULL,
  `starts_on` text,
  `ends_on` text,
  `reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `booking_rules_resource_idx`
  ON `booking_rules` (`resource_id`, `kind`);
--> statement-breakpoint
-- A taken slot. `held` occupies it exactly as `confirmed` does, but only until
-- `hold_expires_at` — and that expiry, like `completed`, is DERIVED at read
-- time rather than swept by a job, so a wedged cron cannot keep a slot closed.
CREATE TABLE IF NOT EXISTS `bookings` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `resource_id` text NOT NULL,
  `start_at` integer NOT NULL,
  `end_at` integer NOT NULL,
  `status` text DEFAULT 'confirmed' NOT NULL,
  `seat` integer DEFAULT 0 NOT NULL,
  `hold_expires_at` integer,
  `customer_name` text,
  `customer_email` text,
  `customer_phone` text,
  `answers` text,
  `notes` text,
  `token_hash` text NOT NULL,
  `mirror_collection` text,
  `mirror_item_id` text,
  `source` text DEFAULT 'public' NOT NULL,
  `cancelled_at` integer,
  `cancel_reason` text,
  `cancelled_by` text,
  `rescheduled_to_id` text,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
-- The manage-link token is the entire grant to cancel or reschedule, so only
-- its hash is at rest.
CREATE UNIQUE INDEX IF NOT EXISTS `bookings_token_idx`
  ON `bookings` (`token_hash`);
--> statement-breakpoint
-- THE capacity guarantee, and the reason `seat` exists.
--
-- "No more than `capacity` bookings at one instant" cannot be enforced by
-- reading and then writing: there is no row lock to take here, so between the
-- count and the insert another writer fits. Sorting the contenders afterwards
-- and making the loser withdraw is closer, but not sound either — a booking
-- that arrives late can sort ahead of one that already checked and passed, and
-- nothing re-checks the earlier one.
--
-- So the database decides it. Each booking claims a numbered place, and this
-- index makes two bookings for the same place at the same instant impossible.
-- The writer walks 0..capacity-1 and takes the first that inserts.
--
-- PARTIAL, over the occupying statuses only: a cancelled or expired booking
-- releases its seat by virtue of its status, with no row having to move. This
-- is also why `expired` is a status that can be written at all — a lapsed hold
-- is expired for every READER by the clock alone, but a writer that wants the
-- seat has to say so in a column the index can see.
CREATE UNIQUE INDEX IF NOT EXISTS `bookings_seat_idx`
  ON `bookings` (`resource_id`, `start_at`, `seat`)
  WHERE `status` IN ('held','confirmed');
--> statement-breakpoint
-- Every slot listing and every write runs "this resource, around this instant".
CREATE INDEX IF NOT EXISTS `bookings_resource_start_idx`
  ON `bookings` (`resource_id`, `start_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bookings_tenant_status_idx`
  ON `bookings` (`tenant_id`, `status`);
