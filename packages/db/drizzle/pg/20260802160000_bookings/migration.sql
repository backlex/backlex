-- Availability and booking — the piece ten of the schema templates were
-- modelling around and none of them could express.
--
-- Why a system ledger rather than "just a collection": a collection can hold a
-- booking perfectly well, and `booking_resources.mirror_collection` is there so
-- that it does. What a collection cannot do is refuse the SECOND write for the
-- same instant. The overlap guard needs one table with one index and one
-- ordering rule that every writer agrees on, and it needs it on a store with no
-- row locks (D1). So the ledger is authoritative for the SLOT and the mirrored
-- row is authoritative for everything the workspace wants to do with it.
--
-- Nothing here stores a computed slot. Slots are derived from the rules on
-- every read, because a materialised slot table has to be regenerated whenever
-- a rule moves and is quietly wrong until it is.
CREATE TABLE IF NOT EXISTS "booking_resources" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  -- The zone the RULES are written in. "Mondays 09:00" does not move when the
  -- clocks do; the instant it names does, and only the operator's own zone can
  -- settle which instant that is.
  "time_zone" text DEFAULT 'UTC' NOT NULL,
  "slot_minutes" integer DEFAULT 30 NOT NULL,
  "step_minutes" integer,
  "capacity" integer DEFAULT 1 NOT NULL,
  "buffer_before_minutes" integer DEFAULT 0 NOT NULL,
  "buffer_after_minutes" integer DEFAULT 0 NOT NULL,
  "lead_minutes" integer DEFAULT 0 NOT NULL,
  "horizon_days" integer DEFAULT 60 NOT NULL,
  -- A hold that never lapsed would let one abandoned checkout close a slot for
  -- good, so the lifetime is policy rather than a constant.
  "hold_minutes" integer DEFAULT 10 NOT NULL,
  "questions" jsonb,
  "mirror_collection" text,
  "mirror_field_map" jsonb,
  "token_hash" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "confirmation_message" text,
  "notify_emails" jsonb,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "booking_resources_tenant_key_idx"
  ON "booking_resources" ("tenant_id", "key");
--> statement-breakpoint
-- Only the SHA-256 of the public page token is stored; the token is shown once
-- on creation, exactly like a form's.
CREATE UNIQUE INDEX IF NOT EXISTS "booking_resources_token_idx"
  ON "booking_resources" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_resources_tenant_idx"
  ON "booking_resources" ("tenant_id");
--> statement-breakpoint
-- One line of an opening pattern, or one exception to it. `open` adds bookable
-- time and `block` takes it away; blocks apply after every open rule has been
-- merged, so a holiday declared once is not subtracted from each pattern
-- separately.
--
-- `start_minute`/`end_minute` are minutes from LOCAL midnight, never instants,
-- and `starts_on`/`ends_on` are TEXT calendar dates rather than `date` or a
-- timestamp: a rule bound must not shift with an offset, and ISO dates compare
-- correctly as plain strings.
--
-- A shift that crosses midnight is expressed as two rules, so that no interval
-- anywhere in the system has to be read as "wraps around".
CREATE TABLE IF NOT EXISTS "booking_rules" (
  "id" text PRIMARY KEY NOT NULL,
  "resource_id" text NOT NULL,
  "kind" text DEFAULT 'open' NOT NULL,
  -- 0=Sunday … 6=Saturday, or NULL for "every day inside the date range" —
  -- which is how a one-off closure is said.
  "weekday" integer,
  "start_minute" integer NOT NULL,
  "end_minute" integer NOT NULL,
  "starts_on" text,
  "ends_on" text,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_rules_resource_idx"
  ON "booking_rules" ("resource_id", "kind");
--> statement-breakpoint
-- A taken slot.
--
-- `held` is the pre-confirmation state a public booker passes through while a
-- deposit is paid or a form is finished. It occupies the slot exactly as a
-- confirmation does, but only until `hold_expires_at` — and that expiry, like
-- `completed` (a confirmed booking whose end has passed), is DERIVED at read
-- time rather than swept by a job. A wedged cron must not be able to keep a
-- slot closed, and yesterday's appointments must stop looking upcoming without
-- anything having to run.
CREATE TABLE IF NOT EXISTS "bookings" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "resource_id" text NOT NULL,
  "start_at" timestamp with time zone NOT NULL,
  "end_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'confirmed' NOT NULL,
  "seat" integer DEFAULT 0 NOT NULL,
  "hold_expires_at" timestamp with time zone,
  "customer_name" text,
  "customer_email" text,
  "customer_phone" text,
  "answers" jsonb,
  "notes" text,
  "token_hash" text NOT NULL,
  "mirror_collection" text,
  "mirror_item_id" text,
  "source" text DEFAULT 'public' NOT NULL,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "cancelled_by" text,
  "rescheduled_to_id" text,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The manage-link token is the entire grant to cancel or reschedule, so only
-- its hash is at rest: a readable copy would let anyone with database access
-- cancel a stranger's appointment.
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_token_idx"
  ON "bookings" ("token_hash");
--> statement-breakpoint
-- THE capacity guarantee, and the reason `seat` exists.
--
-- "No more than `capacity` bookings at one instant" cannot be enforced by
-- reading and then writing: between the count and the insert another writer
-- fits. Sorting the contenders afterwards and making the loser withdraw is
-- closer but still unsound — a booking that arrives late can sort ahead of one
-- that already checked and passed, and nothing re-checks the earlier one.
--
-- So the database decides it. Each booking claims a numbered place and this
-- index makes two bookings for the same place at the same instant impossible;
-- the writer walks 0..capacity-1 and takes the first that inserts.
--
-- PARTIAL, over the occupying statuses only: a cancelled or expired booking
-- releases its seat by virtue of its status, with no row having to move. That
-- is also why `expired` is a status that can be written at all — a lapsed hold
-- is expired for every READER by the clock alone, but a writer that wants the
-- seat back has to say so in a column the index can see.
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_seat_idx"
  ON "bookings" ("resource_id", "start_at", "seat")
  WHERE "status" IN ('held','confirmed');
--> statement-breakpoint
-- The overlap query is always "this resource, around this instant", and it runs
-- on every slot listing and every write, so the resource leads and the start
-- time follows it.
CREATE INDEX IF NOT EXISTS "bookings_resource_start_idx"
  ON "bookings" ("resource_id", "start_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_tenant_status_idx"
  ON "bookings" ("tenant_id", "status");
