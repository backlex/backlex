-- The grouping key for page reports.
--
-- `analytics_events.path` deliberately carries the query string: campaign tags
-- live there, and `?q=` / `?page=2` are real information a page report should
-- not throw away. But GROUPING on it splits one page into a row per campaign
-- variant — `/pricing?utm_source=a` and `/pricing?utm_source=b` report as two
-- different pages, which is wrong and was visible on the first live traffic
-- this feature ever collected.
--
-- So the grouping key is materialized at write time, exactly as `day` and
-- `hour` are, and for the same reason: there is no substring-before-a-character
-- expression with a common spelling across Postgres, SQLite and D1. Grouping on
-- a stored column is also indexable, which grouping on an expression is not.
--
-- The backfill is dialect-specific and that is fine — these two files are
-- separate precisely so each can use its own functions. `split_part` returns
-- the whole string when the separator is absent, so a path with no query is
-- copied unchanged.
--
-- Replay safety: `ADD COLUMN IF NOT EXISTS` is idempotent, and the UPDATE is
-- guarded on `path_base IS NULL` so a second run is a no-op.

ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "path_base" text;--> statement-breakpoint
UPDATE "analytics_events" SET "path_base" = split_part("path", '?', 1) WHERE "path" IS NOT NULL AND "path_base" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_tenant_path_base_idx" ON "analytics_events" ("tenant_id","path_base");
