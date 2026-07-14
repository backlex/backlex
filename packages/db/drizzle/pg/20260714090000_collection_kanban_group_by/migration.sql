-- Kanban group-by: the field the admin Kanban view groups cards by. Stores a
-- user field's name (a `dropdown`/`select` field) or the special `_status`
-- lifecycle column on versioned collections. Null = auto-detect (a field
-- literally named `status`, else the first dropdown). See the sqlite twin.

ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "kanban_group_by" text;
