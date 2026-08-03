-- Sequence fields: a document number the server issues (INV-2026-0001).
-- SQLite/D1 twin of the pg migration, where the reasoning is written out in
-- full.
--
-- The short version: the pattern and the reset period are field metadata in
-- `collections.fields`; only the counter needs a table. Allocation is a single
-- `INSERT … ON CONFLICT DO UPDATE SET last_value = sequences.last_value + :n
-- RETURNING last_value`, so two concurrent creates cannot both claim the same
-- number, and a bulk insert of n rows takes a block of n in one round trip.
--
-- The series is unique and monotonic, NOT gap-free: the counter is bumped
-- outside the row write's transaction, so a number requested by an insert that
-- then fails is spent — the same trade-off a Postgres SEQUENCE makes.
CREATE TABLE IF NOT EXISTS `sequences` (
  `id` text PRIMARY KEY NOT NULL,
  -- NOT NULL with '' for "no tenant": a unique index treats NULLs as DISTINCT,
  -- so a nullable key column would allow a second counter row, the ON CONFLICT
  -- would stop matching, and every document would get the same number.
  `tenant_id` text DEFAULT '' NOT NULL,
  `collection` text NOT NULL,
  `field` text NOT NULL,
  -- '' for `reset: never`, else the calendar period ('2026', '2026-08',
  -- '2026-08-03') in the spec's own time zone. Nothing runs at midnight — a
  -- new period is simply a bucket that does not exist yet.
  `scope` text DEFAULT '' NOT NULL,
  -- The last counter handed out; the next allocation returns this + n.
  `last_value` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
-- The ON CONFLICT target, and therefore the concurrency guarantee itself.
CREATE UNIQUE INDEX IF NOT EXISTS `sequences_key_idx`
  ON `sequences` (`tenant_id`, `collection`, `field`, `scope`);
