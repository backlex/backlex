-- Two-factor lockout state — better-auth 1.6.29 added two fields to its
-- `twoFactor` model, and its Drizzle adapter validates the schema by property
-- name at call time. Without these columns EVERY two-factor endpoint throws
-- `BetterAuthError: The field "failedVerificationCount" does not exist in the
-- "twoFactor" Drizzle schema` and returns a 500 — enrolment, verification and
-- the gated sign-in alike. So this is a hard requirement of the upgrade, not
-- an opt-in feature.
--
-- What the plugin does with them: `failed_verification_count` increments on
-- each wrong code and resets to 0 on a good one; once it crosses the plugin's
-- threshold the plugin stamps `locked_until`, and attempts are refused until
-- that instant passes.
--
-- `failed_verification_count` is NOT NULL DEFAULT 0 so existing enrolments
-- start from a clean counter rather than a NULL the plugin would have to
-- coalesce. `locked_until` is nullable — NULL means "not locked", which is the
-- correct state for every row that exists today.
--
-- Replay safety: `ADD COLUMN IF NOT EXISTS` is idempotent on Postgres, so
-- auto-migrate re-running this file is a no-op rather than an error.

ALTER TABLE "twoFactor" ADD COLUMN IF NOT EXISTS "failed_verification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "twoFactor" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
