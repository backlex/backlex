-- The five instance-wide email templates that no sender read are removed (#384).
--
-- `seedEmailTemplates` inserted `verify`, `reset`, `magic`, `invite` and
-- `change_email` with `tenant_id = NULL` on the first request of every isolate,
-- and Settings → Email templates listed them as editable. Nothing ever resolved
-- one: sign-in, verification, password-reset and invite mail is composed inline
-- in `packages/auth` and at each invite's send site, and nothing sends a
-- `change_email` mail at all. An admin's edit changed nothing a recipient
-- received. The seeder is deleted in the same change, and this removes the rows
-- it left behind.
--
-- ONLY the shared rows. A workspace's own row under one of these keys was
-- written by that workspace's admin (saving a shared default writes a copy), so
-- it is that workspace's data and it stays. It remains what it always was in
-- practice: a custom template, sent only when a flow step or a scheduled report
-- names its key. Templating the mail a workspace owns is #394, under NEW keys,
-- so that none of those copies goes live.
--
-- What changes for a sender: a flow `email` step that names one of these keys,
-- in a workspace without its own copy, and gives no subject and body of its own,
-- now fails its run with `Email template "<key>" not found and no fallback
-- provided` instead of mailing the shared row with every link rendered empty. A
-- scheduled report always carries its own wording and falls back to it.
--
-- Two shared rows for one key are removed alike. The UNIQUE index on
-- (tenant_id, key) treats NULLs as distinct, so the seeder's check-then-insert
-- could leave duplicates behind two isolates that booted together.
--
-- Replayable: once the shared rows are gone the DELETE matches nothing and raises
-- nothing, which is what the boot-time runner needs — it re-applies any file its
-- `__backlex_migrations` ledger does not name.

DELETE FROM "email_templates"
 WHERE "tenant_id" IS NULL
   AND "key" IN ('verify', 'reset', 'magic', 'invite', 'change_email');
