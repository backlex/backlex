-- Broadcast channels — a permission rule for the free-form realtime channels
-- that until now had none, plus the retained message log that backs replay.
--
-- `subscribe` / `publish` are whole JSON objects, not a roles column beside a
-- condition column: "who may do this" has four answers (nobody / anyone /
-- any signed-in user / these roles) and two nullable columns can spell three.
-- They are stored as TEXT rather than jsonb, and so is `payload`, so both
-- dialects hand the application a string and ONE function decides what an
-- unparseable rule means (nobody). A driver-parsed column throws inside the
-- SQLite row mapper, where no fail-closed default can be applied at all.
--
-- `broadcast_messages.day` is a YYYYMMDD integer, the coarse partition key.
-- Real partitioning is not available on the SQLite twin (D1), so the same
-- operational property — one ranged DELETE to prune, no timestamp scan — is
-- bought with an indexed integer instead, identically on both dialects.

CREATE TABLE IF NOT EXISTS "broadcast_channels" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "pattern" text NOT NULL,
  "subscribe" text NOT NULL,
  "publish" text NOT NULL,
  "presence" boolean DEFAULT false NOT NULL,
  "replay" boolean DEFAULT false NOT NULL,
  "retention_hours" integer DEFAULT 24 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_channels_pattern_idx"
  ON "broadcast_channels" ("tenant_id","pattern");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_channels_tenant_idx"
  ON "broadcast_channels" ("tenant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "broadcast_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "day" integer NOT NULL,
  "event" text NOT NULL,
  "payload" text,
  "sender_id" text,
  "sender_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_messages_read_idx"
  ON "broadcast_messages" ("tenant_id","channel","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_messages_day_idx"
  ON "broadcast_messages" ("day");
