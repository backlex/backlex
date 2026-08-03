-- Date-relative flow triggers. SQLite/D1 twin of the pg migration, where the
-- design reasoning is written out in full.
--
-- The short version: the scan looks back over a two-day catch-up window so a
-- restart or a cold serverless tick cannot silently drop a reminder, which
-- means every tick re-sees rows it has already fired on. This table is what
-- remembers, and the unique index is what makes the dispatch exactly-once
-- across processes. The claim is INSERT-then-run, never the other way round.
CREATE TABLE IF NOT EXISTS `flow_schedule_fires` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `flow_id` text NOT NULL,
  -- Text regardless of the collection's PK type; the ledger only compares it.
  `row_id` text NOT NULL,
  -- The COMPUTED fire instant, not the instant we noticed it.
  `fire_at` integer NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
-- THE exactly-once guarantee. `fire_at` is in the key so that moving a due date
-- fires again while an untouched row stays quiet.
CREATE UNIQUE INDEX IF NOT EXISTS `flow_schedule_fires_once_idx`
  ON `flow_schedule_fires` (`flow_id`, `row_id`, `fire_at`);
--> statement-breakpoint
-- Pruning reads this and nothing else.
CREATE INDEX IF NOT EXISTS `flow_schedule_fires_prune_idx`
  ON `flow_schedule_fires` (`fire_at`);
