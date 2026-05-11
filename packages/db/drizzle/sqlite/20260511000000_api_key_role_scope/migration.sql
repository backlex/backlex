-- Optional per-key role scoping. Mirrors the PG migration: adds `role_id`
-- to `api_keys`. NULL = the key inherits its owner's full role set (legacy
-- behaviour). When set, requests made with the key resolve permissions
-- against only that role — and only while the owner still holds it
-- (see apps/web/src/server/services/permissions.ts). No back-fill: existing
-- keys stay unscoped.

ALTER TABLE `api_keys` ADD COLUMN `role_id` text;--> statement-breakpoint
CREATE INDEX `api_keys_role_idx` ON `api_keys` (`role_id`);
