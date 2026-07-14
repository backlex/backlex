-- Kanban action map: maps a group-by dropdown value to a draft/publish
-- lifecycle action (publish | unpublish | archive) so a custom-status column
-- (e.g. `done`) can also fire a lifecycle transition. See the sqlite twin.

ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "kanban_action_map" jsonb;
