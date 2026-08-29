-- The instance-global settings tier stops being NULL.
--
-- `app_settings` addressed the instance-wide tier as `tenant_id IS NULL`, which
-- makes "this row is the global default" indistinguishable from "this row's
-- tenant column was never filled in". The repo did not even agree with itself:
-- `routes/auth-admin.ts` and the email/push/SMS selectors already wrote the
-- literal `'_global'`, while other writers left NULL for the same tier, so one
-- table held two representations of one thing and a reader that knew only one
-- of them saw half the settings.
--
-- NULL is worse than merely ambiguous here, because of the UNIQUE index on
-- (tenant_id, key). Measured against both engines rather than assumed: a UNIQUE
-- index treats NULLs as DISTINCT in Postgres AND in SQLite, so `(NULL,
-- 'branding')` could be inserted without limit. The index that exists to keep
-- one row per key was enforcing nothing at all for the global tier, and a
-- deployment that has been running a while can therefore hold several rows for
-- the same global key with no error ever raised.
--
-- So the move is two statements and the ORDER MATTERS. De-duplicate first,
-- because the UPDATE below is the moment the index starts applying to this
-- tier: running it against a table that still holds duplicates raises a unique
-- violation and the whole migration is recorded as failed.
--
-- The de-duplication spans BOTH representations — `COALESCE(tenant_id,
-- '_global')` — since a key can legitimately have one NULL row and one
-- '_global' row today, and after the UPDATE those two would collide. Newest
-- `updated_at` wins, with `id` as a deterministic tie-break so a table where two
-- rows share a millisecond still resolves the same way on every replay and on
-- both dialects. That discards data, and it is the honest choice: the rows are
-- competing answers to one question, only one of them was ever being read, and
-- the newest is the one an admin last chose.
--
-- The column is deliberately left NULLABLE. Converting it to NOT NULL would
-- require a full table rebuild on SQLite (CREATE new, INSERT SELECT, DROP old,
-- RENAME) and this file runs on the boot path of every Vercel and Netlify cold
-- start via `auto-migrate.ts`; a process that dies between the DROP and the
-- RENAME loses the instance's entire settings table. A legacy NULL that this
-- migration has already cleared is a far smaller problem than that, and the
-- read path treats the two as one tier regardless.
--
-- Replayable: after the first pass no row has `tenant_id IS NULL`, so the
-- DELETE matches the surviving single row per key (`id <> id` is false, nothing
-- is removed) and the UPDATE matches nothing. Both are no-ops rather than
-- errors, which is what the boot-time runner needs — it re-applies every
-- migration file whenever the `__backlex_migrations` ledger does not name it.

DELETE FROM "app_settings"
 WHERE COALESCE("tenant_id", '_global') = '_global'
   AND "id" <> (
     SELECT s."id"
       FROM "app_settings" s
      WHERE COALESCE(s."tenant_id", '_global') = '_global'
        AND s."key" = "app_settings"."key"
      ORDER BY s."updated_at" DESC, s."id" DESC
      LIMIT 1
   );
--> statement-breakpoint
UPDATE "app_settings" SET "tenant_id" = '_global' WHERE "tenant_id" IS NULL;
