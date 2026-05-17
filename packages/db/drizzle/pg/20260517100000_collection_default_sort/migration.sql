-- Per-collection default sort. Comma-separated field list, `-` prefix = DESC
-- (Directus-style — same shape `parseQuery` already parses from `?sort=`).
-- Consumed by `apps/web/src/server/lib/query.ts::parseQuery` as the fallback
-- when the request omits `?sort=`. Null preserves the previous hard-coded
-- behavior (`-created_at`).

ALTER TABLE "collections" ADD COLUMN "default_sort" text;
