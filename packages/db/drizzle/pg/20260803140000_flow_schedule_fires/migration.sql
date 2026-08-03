-- Date-relative flow triggers ("three days before this invoice is due").
--
-- The trigger spec itself lives in `flows.trigger`, as every other trigger kind
-- does, so this migration adds only the piece that could not live in a column:
-- the record of what has already been dispatched.
--
-- Why that record is needed at all. A scan could in principle fire on a time
-- WINDOW — everything whose instant fell since the last tick — and store
-- nothing. That is what the cron path does, and it is wrong here. The window's
-- left edge is per-process state, and on every serverless runtime a tick may
-- run in a fresh instance where there is no such state; a restart, a deploy or
-- a cold gap then drops every reminder whose instant fell inside it. Nobody
-- notices, because the symptom of a missing reminder is silence.
--
-- So the scan looks back over a two-day catch-up window instead, which means it
-- re-sees rows it has already fired on every single tick. Something has to
-- remember which ones, durably and across processes. A unique index is the only
-- thing available that can — the same shape as the booking seat index.
--
-- The claim is INSERT-then-run, in that order: whoever wins the insert owns the
-- dispatch and a loser does nothing at all. Running first and recording after
-- would double-send whenever two instances tick together, and what sits behind
-- a flow is arbitrary operator work — a second email, a second charge.
CREATE TABLE IF NOT EXISTS "flow_schedule_fires" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "flow_id" text NOT NULL,
  -- Text regardless of the collection's PK type (uuid / text / integer): the
  -- ledger only ever compares this for equality, and one column type across
  -- every collection keeps the index single.
  "row_id" text NOT NULL,
  -- The COMPUTED fire instant, not the instant we noticed it.
  "fire_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- THE exactly-once guarantee.
--
-- `fire_at` is part of the key rather than just (flow, row) so that moving a
-- due date is honoured: the new instant is a new claim and fires, while a row
-- nobody touched keeps colliding with the entry already there and stays quiet.
-- Keyed on (flow, row) alone, correcting a date would silently suppress the
-- corrected reminder — the one case where the operator most wants it.
CREATE UNIQUE INDEX IF NOT EXISTS "flow_schedule_fires_once_idx"
  ON "flow_schedule_fires" ("flow_id", "row_id", "fire_at");
--> statement-breakpoint
-- Pruning reads this and nothing else. An entry older than the catch-up window
-- can never be selected by a scan again, so it is safe to drop.
CREATE INDEX IF NOT EXISTS "flow_schedule_fires_prune_idx"
  ON "flow_schedule_fires" ("fire_at");
