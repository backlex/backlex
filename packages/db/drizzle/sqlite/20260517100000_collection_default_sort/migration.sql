-- Per-collection default sort. Comma-separated field list, `-` prefix = DESC
-- (Directus-style — same shape `parseQuery` already parses from `?sort=`).
-- Null preserves the previous hard-coded behavior (`-created_at`).

ALTER TABLE collections ADD COLUMN default_sort TEXT;
