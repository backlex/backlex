-- Inbound webhooks — a provider calling US, landing where a pull would.
--
-- The four capabilities before this all start on our side: we deliver, we pull,
-- we push, we ask a provider to act on a row. Two of the things this engine
-- already does are the wrong shape for that. A parcel's progress is one request
-- per parcel per interval and still late; a marketplace order's status is a
-- 14-day window walked every few minutes to notice one cancellation.
--
-- The columns go on `integration_syncs` rather than into a table of their own,
-- and that is the whole design decision. A delivery has to land exactly where a
-- pull would — same collection, same field mapping, and above all the same id
-- namespace, which is derived from the sync row's id. A webhook holding its own
-- row would mint `trendyol_<hookid>_<pkg>` beside the poll's
-- `trendyol_<syncid>_<pkg>`, and every order a seller has would exist twice with
-- neither copy complete. Riding on the sync means the push and the poll converge
-- on ONE row, which is also why the poll is kept: webhooks are lossy everywhere,
-- an endpoint that was down for an hour is an hour nobody re-sends, and a sync
-- that also polls repairs exactly that.
--
-- `direction` gains a third value, `inbound`, for a provider that has nothing to
-- poll — a carrier tells you where a parcel is, but there is no list of parcels
-- to walk. Such a row is never due (the scheduler reads `interval_minutes > 0`),
-- so it needs no special case there.

ALTER TABLE "integration_syncs" ADD COLUMN "webhook_token" text;--> statement-breakpoint
ALTER TABLE "integration_syncs" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "integration_syncs" ADD COLUMN "webhook_events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_syncs" ADD COLUMN "webhook_external_id" text;--> statement-breakpoint
ALTER TABLE "integration_syncs" ADD COLUMN "match_field" text;--> statement-breakpoint

-- One token means one subscription: the delivery path resolves it on every
-- inbound request and must never find two. Partial, because the many syncs with
-- no endpoint would otherwise collide on null.
CREATE UNIQUE INDEX IF NOT EXISTS "integration_syncs_webhook_token_idx"
  ON "integration_syncs" ("webhook_token") WHERE "webhook_token" IS NOT NULL;--> statement-breakpoint

-- One delivery, and what became of it.
--
-- Two jobs in one table. It is the log an operator reads when a marketplace
-- insists it sent something — with the verdict, so "it arrived and we ignored
-- it" is distinguishable from "nothing arrived". And it is the replay guard:
-- `delivery_id` under a unique index means a retry is recognised as the delivery
-- already applied instead of applied again. Retries are the normal case here,
-- not an edge one — EasyPost retries six times, Trendyol every five minutes
-- until it succeeds and then deactivates the endpoint.
--
-- Scoped to the subscription rather than globally unique: two workspaces
-- watching two sellers may legitimately be sent the same provider event id.
--
-- This table is also why the sync row grew no `webhook_last_*` columns. The
-- health of an endpoint is derivable from its deliveries, and two places
-- recording the same fact is how they come to disagree.
CREATE TABLE IF NOT EXISTS "integration_webhook_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "sync_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "event" text NOT NULL,
  "delivery_id" text NOT NULL,
  "status" text NOT NULL,
  "rows_written" integer DEFAULT 0 NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_webhook_deliveries_once_idx"
  ON "integration_webhook_deliveries" ("sync_id", "delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_tenant_idx"
  ON "integration_webhook_deliveries" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_sync_idx"
  ON "integration_webhook_deliveries" ("sync_id", "created_at");
