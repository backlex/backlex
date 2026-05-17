-- Adopted collections can map an existing column to a system field instead
-- of requiring the conventional name. `inserted_at` becomes `created_at` in
-- the API, `user_id` becomes `owner_id`, etc. — without DDL on the source
-- table. The columns are nullable; null means "use the conventional name"
-- (every managed collection ends up here by default).
--
-- `owner_id_column` doubles as the override that bypasses the
-- `item_ownership` side-table: when set, ownership reads/writes go to the
-- source column directly.

ALTER TABLE "collections" ADD COLUMN "created_at_column" text;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "updated_at_column" text;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "owner_id_column" text;
