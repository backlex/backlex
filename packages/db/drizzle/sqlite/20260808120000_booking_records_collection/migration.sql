-- Every booking is recorded in a collection. SQLite/D1 twin of the pg
-- migration, where the reasoning is written out in full.
--
-- The short version: mirroring into a collection was the right split (the
-- ledger owns the slot and its capacity index; everything else a booking is
-- belongs where permissions, flows, realtime and exports already work) but it
-- was opt-in through two settings that had to agree, and the admin exposed only
-- one of them. Naming a target without a field map recorded nothing, silently.
-- It is now on by default, into a collection the platform provisions with a
-- shape it knows, whose field map is derived in code rather than stored.
--
-- `mirror_enabled` defaults to 1 so resources that predate this start recording
-- on their next booking — they were never offered the choice, so the default is
-- the answer, not an accident. `mirror_error` makes a best-effort write that
-- failed legible instead of invisible. The collection itself is provisioned by
-- `ensureBookingCollection`, not here: a collection is a metadata row plus DDL
-- derived from it, per workspace, and this file has no per-tenant view.
ALTER TABLE `booking_resources` ADD COLUMN `mirror_enabled` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `bookings` ADD COLUMN `mirror_error` text;
