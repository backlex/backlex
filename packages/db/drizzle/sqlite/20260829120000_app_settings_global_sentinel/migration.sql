-- The instance-global settings tier stops being NULL — SQLite/D1 twin.
--
-- See the pg migration for the full reasoning: why NULL and '_global' both
-- existed in one table, why the UNIQUE index on (tenant_id, key) was enforcing
-- nothing for the global tier, why the de-duplication must run BEFORE the
-- UPDATE, and why the column stays nullable.
--
-- Not a dialect difference, and worth writing down because it is easy to assume
-- otherwise: SQLite and Postgres AGREE here. Both treat NULLs as distinct in a
-- UNIQUE index, so duplicate global rows were possible on both and both need
-- the same de-duplication. This file is the pg statement with SQLite quoting.
--
-- Replayable for the same reason as the pg twin: after the first pass nothing
-- matches `tenant_id IS NULL`, and the DELETE only ever spares the single
-- surviving row per key. Neither statement raises on a second application, so
-- there is nothing here for `ALREADY_EXISTS_RE` to have to tolerate.

DELETE FROM `app_settings`
 WHERE COALESCE(`tenant_id`, '_global') = '_global'
   AND `id` <> (
     SELECT s.`id`
       FROM `app_settings` s
      WHERE COALESCE(s.`tenant_id`, '_global') = '_global'
        AND s.`key` = `app_settings`.`key`
      ORDER BY s.`updated_at` DESC, s.`id` DESC
      LIMIT 1
   );
--> statement-breakpoint
UPDATE `app_settings` SET `tenant_id` = '_global' WHERE `tenant_id` IS NULL;
