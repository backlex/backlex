-- KPI alerts: the figure tells you it moved, instead of waiting to be looked at.
--
-- A KPI answers a question when somebody opens a page. The ones that matter
-- most are the ones nobody thinks to open — a cancellation rate that doubled
-- overnight is not a thing you go looking for, it is a thing that should come
-- and find you. These four columns turn a definition into a watch.
--
-- The rule lives ON the KPI rather than in a separate rules table because it is
-- not a separate thing: "refund rate" and "tell me when refund rate goes above
-- 5%" are one concern, and splitting them means a second row to keep in step
-- every time the definition is edited. A KPI has at most one threshold; wanting
-- two is wanting two KPIs, and saying so keeps the tile honest about which
-- number is being watched.
ALTER TABLE "kpis" ADD COLUMN IF NOT EXISTS "alert_operator" text;
--> statement-breakpoint
ALTER TABLE "kpis" ADD COLUMN IF NOT EXISTS "alert_value" double precision;
--> statement-breakpoint
-- Whether the alert is CURRENTLY breaching.
--
-- This is what makes the alert fire on the transition into breach rather than
-- on every tick. Without it the scheduler re-notifies once a minute for as long
-- as the condition holds, which trains people to ignore the channel — and an
-- alert nobody reads is worse than no alert, because it looks like coverage.
-- Cleared when the figure comes back inside the threshold, so the next breach
-- notifies again.
ALTER TABLE "kpis" ADD COLUMN IF NOT EXISTS "alert_firing" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "kpis" ADD COLUMN IF NOT EXISTS "alert_last_fired_at" timestamptz;
