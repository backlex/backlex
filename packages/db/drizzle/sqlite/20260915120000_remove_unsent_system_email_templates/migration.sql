-- The five instance-wide email templates that no sender read are removed — the
-- SQLite/D1 twin. See the pg migration for why the rows existed, why a
-- workspace's own copy under the same key is kept, and what a flow step that
-- names one of the keys does afterwards (#384).
--
-- Not a dialect difference: SQLite, like Postgres, treats NULLs as distinct in
-- the UNIQUE index on (tenant_id, key), so duplicate shared rows were possible
-- here too, and the same single statement removes every one of them.
--
-- Replayable for the same reason as the pg twin: a second application matches
-- nothing and raises nothing.

DELETE FROM `email_templates`
 WHERE `tenant_id` IS NULL
   AND `key` IN ('verify', 'reset', 'magic', 'invite', 'change_email');
