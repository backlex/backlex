-- Website-analytics dimensions on the product-analytics event stream.
--
-- `analytics_events` could answer "how many people did X" but nothing a Google
-- Analytics user opens the tool for: which country, which device, which
-- campaign, which session. The columns below are the first phase of closing
-- that; nothing here changes how an existing row is read.
--
-- WHY THESE ARE COLUMNS AND `utm_term` / `utm_content` ARE NOT.
-- The line is: a column if a report GROUPs BY or filters on it, `props`
-- otherwise. That is not style — `PARAM_BUDGET` (90) in
-- `apps/web/src/server/services/analytics.ts` is divided by the column count to
-- size each multi-row INSERT, because D1 caps a statement at ~100 bound
-- parameters. Going from 17 to 26 columns takes a batch from ~5 rows per
-- statement to 3, on the highest-volume write path in the product. Every
-- column added here is paid for on every event forever, so the ones that only
-- ever get displayed live in `props`.
--
-- `id_scope` IS LOAD-BEARING, NOT METADATA.
-- Phase 2 introduces a cookieless visitor id: a server-derived hash that
-- rotates at UTC midnight. Under that id a visitor who returns for 30 days is
-- 30 distinct ids, which would silently corrupt three existing reports —
-- `analyticsOverview.totals.users` (a range-wide `count(distinct distinct_id)`,
-- and the headline tile on the page), daily-cohort retention, and multi-day
-- funnels. Those reports filter to `id_scope = 'durable'`. The DEFAULT is what
-- backfills every pre-existing row, and `durable` is factually correct for
-- them: they all came from the SDK's localStorage id.
--
-- `hour` mirrors `day`. Both exist because there is no hour- or day-bucketing
-- expression with a common spelling across Postgres, SQLite and D1, so the
-- bucket is materialized at write time instead. It is NULL on rows written
-- before this migration; consumers must treat NULL as "not measured".
--
-- `revenue` is bigint, in the currency's MINOR units, and is never summed
-- across `currency` — there is no FX rate source in this repo and a silently
-- mixed total is worse than no total. bigint rather than integer because
-- minor units in a low-denomination currency overflow int4 at ~21M units.
--
-- Replay safety: `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
-- are idempotent, so auto-migrate re-running this file is a no-op.

ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "site_id" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "id_scope" text DEFAULT 'durable';--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "device_type" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "browser" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "os" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_source" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_medium" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "revenue" bigint;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "currency" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "hour" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_tenant_hour_idx" ON "analytics_events" ("tenant_id","hour");--> statement-breakpoint
-- Sessionization (phase 4) partitions by `distinct_id` ordered by `ts` and
-- range-filters on `day`. The existing `(tenant_id, distinct_id, ts)` index
-- cannot serve that — the day filter is not a prefix of its ordering, so the
-- planner scans the tenant's entire history. Landed now, while the table is
-- small, rather than with the query that needs it.
CREATE INDEX IF NOT EXISTS "analytics_events_tenant_day_distinct_ts_idx" ON "analytics_events" ("tenant_id","day","distinct_id","ts");
